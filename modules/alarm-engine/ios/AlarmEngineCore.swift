import ActivityKit
import AlarmKit
import AppIntents
import Foundation
import SwiftUI

/// Delivers engine events to JS while the Expo module is alive. Intents run in the app
/// process even when JS is dead; then there is no sink and only the observed log records it.
final class AlarmEngineEvents: @unchecked Sendable {
  static let shared = AlarmEngineEvents()

  private let lock = NSLock()
  private var sink: ((String, [String: Any]) -> Void)?

  func setSink(_ sink: ((String, [String: Any]) -> Void)?) {
    lock.lock()
    self.sink = sink
    lock.unlock()
  }

  func emit(_ name: String, _ payload: EnginePayload) {
    lock.lock()
    let sink = self.sink
    lock.unlock()
    sink?(name, payload.wire)
  }
}

/// The iOS alarm engine (AlarmKit, D4). One actor owns the mirror, the ringing record and the
/// observed-event log; module calls, App Intents and AlarmKit/clock observers all go through
/// it, and `exclusive` serializes them across `await`s (actor reentrancy).
actor AlarmEngineCore {
  static let shared = AlarmEngineCore()

  static let maxEvents = 500
  /// Follow-up rings per occurrence after the mission was bypassed (D14). Bounded so a person
  /// who keeps pressing Stop is not woken forever.
  static let maxRetriggers = 5
  static let stopRetriggerDelay: TimeInterval = 60
  /// "Open" stops the system alert; if the in-app mission isn't finished by then, ring again.
  static let openSafetyDelay: TimeInterval = 180
  static let previewDelay: TimeInterval = 5
  /// How long our own stop(id:) suppresses a Stop intent for the same alarm.
  static let handledWindow: TimeInterval = 600
  /// A ringing record nobody resolved (and that isn't alerting) is dropped after this.
  static let staleRingingAge: TimeInterval = 2 * 3600
  static let rearmedRetention: TimeInterval = 14 * 86_400

  private enum SecondaryAction {
    case none, open, snooze
  }

  private struct RingContext {
    var spec: AlarmSpec
    var alarmUUID: String
  }

  private let store = AlarmEngineStore()
  private var state = EngineState()
  private var loaded = false
  private var started = false
  /// Alerting AlarmKit ids already handled in this process (alarmUpdates repeats lists).
  private var alertingSeen = Set<UUID>()

  private var busy = false
  private var waiters: [CheckedContinuation<Void, Never>] = []

  // MARK: - Serialization

  private func acquire() async {
    if busy {
      await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
        waiters.append(continuation)
      }
    } else {
      busy = true
    }
  }

  private func release() {
    if waiters.isEmpty {
      busy = false
    } else {
      waiters.removeFirst().resume()
    }
  }

  /// Runs `body` with the engine lock held and the state loaded / observers started.
  private func exclusive<T>(_ body: () async throws -> T) async throws -> T {
    await acquire()
    defer { release() }
    await prepare()
    return try await body()
  }

  private func prepare() async {
    if !loaded { loadState() }
    guard !started else { return }
    started = true
    startObservers()
    await maintenance(reason: "launch")
  }

  private func loadState() {
    do {
      let result = try store.load()
      state = result.state
      loaded = true
      if result.corrupt {
        record("schedule_failed", scheduleId: "", alarmId: "", occurrenceKey: "", detail: "mirror_corrupt_reset")
        try? persist()
      }
    } catch {
      // Typically before the first unlock after a reboot. Never overwrite the file; retry later.
      loaded = false
      NSLog("[AlarmEngine] mirror unreadable: %@", String(describing: error))
    }
  }

  private func requireLoaded() throws {
    guard loaded else {
      throw EngineError(.unknown, "Alarm storage is unavailable until the device is unlocked once after restart")
    }
  }

  private func persist() throws {
    try requireLoaded()
    if state.events.count > Self.maxEvents {
      state.events.removeFirst(state.events.count - Self.maxEvents)
    }
    let now = Date()
    state.handled = state.handled.filter { _, mark in
      (EngineTime.parse(mark.at).map { now.timeIntervalSince($0) < Self.handledWindow }) ?? false
    }
    state.rearmed = state.rearmed.filter { _, at in
      (EngineTime.parse(at).map { now.timeIntervalSince($0) < Self.rearmedRetention }) ?? false
    }
    state.triggered = state.triggered.filter { _, at in
      (EngineTime.parse(at).map { now.timeIntervalSince($0) < Self.rearmedRetention }) ?? false
    }
    state.fired = state.fired.filter { _, firedRecord in
      (EngineTime.parse(firedRecord.at).map { now.timeIntervalSince($0) < Self.staleRingingAge * 6 }) ?? false
    }
    do {
      try store.save(state)
    } catch {
      throw EngineError(.unknown, "Could not write the alarm mirror: \(error.localizedDescription)")
    }
  }

  private func startObservers() {
    Task.detached {
      for await _ in AlarmManager.shared.alarmUpdates {
        await AlarmEngineCore.shared.handleAlarmUpdates()
      }
    }
    let center = NotificationCenter.default
    _ = center.addObserver(forName: .NSSystemTimeZoneDidChange, object: nil, queue: nil) { _ in
      Task { await AlarmEngineCore.shared.handleClockChange(reason: "timezone_changed") }
    }
    // UIApplication.significantTimeChangeNotification (by name: no main-actor UIKit access).
    let significantTimeChange = Notification.Name("UIApplicationSignificantTimeChangeNotification")
    _ = center.addObserver(forName: significantTimeChange, object: nil, queue: nil) { _ in
      Task { await AlarmEngineCore.shared.handleClockChange(reason: "significant_time_change") }
    }
  }

  // MARK: - Module API

  func start() async {
    _ = try? await exclusive {}
  }

  func schedule(_ spec: AlarmSpec) async throws -> MirrorEntry {
    try await exclusive {
      try validate(spec, requireFuture: true)
      try await requireAuthorization(prompt: true)
      try requireLoaded()
      return try await upsert(spec)
    }
  }

  func cancel(_ id: String) async throws {
    try await exclusive {
      try requireLoaded()
      let uuid = EngineTime.alarmUUID(for: id)
      // Never kill a ring in progress: it ends through dismiss/snooze/Stop.
      if !isAlerting(uuid) {
        try? AlarmManager.shared.cancel(id: uuid)
      }
      state.entries.removeValue(forKey: id)
      try persist()
    }
  }

  func cancelAll() async throws {
    try await exclusive {
      try requireLoaded()
      var uuids = Set(state.entries.keys.map { EngineTime.alarmUUID(for: $0) })
      uuids.formUnion(state.previews.keys.compactMap { UUID(uuidString: $0) })
      // Orphans too (e.g. a mirror reset): cancelAll means nothing of ours stays armed.
      if let alarms = try? AlarmManager.shared.alarms {
        uuids.formUnion(alarms.map(\.id))
      }
      for uuid in uuids where !isAlerting(uuid) {
        try? AlarmManager.shared.cancel(id: uuid)
      }
      state.entries.removeAll()
      state.previews = state.previews.filter { key, _ in UUID(uuidString: key).map { isAlerting($0) } ?? false }
      try persist()
    }
  }

  func getScheduled() async throws -> [MirrorEntry] {
    try await exclusive {
      try requireLoaded()
      await reconcileWithOS()
      try? persist()
      let alerting = alertingIds()
      return state.entries.values
        .filter { !alerting.contains(EngineTime.alarmUUID(for: $0.spec.id)) }
        .sorted { lhs, rhs in
          (EngineTime.parse(lhs.spec.fireAt) ?? .distantFuture) < (EngineTime.parse(rhs.spec.fireAt) ?? .distantFuture)
        }
    }
  }

  func getReadiness() async throws -> Readiness {
    try await exclusive {
      var items: [ReadinessItem] = []
      if loaded {
        items.append(ReadinessItem(
          kind: "engine", status: "ok", title: "Alarm engine",
          detail: "Alarms are scheduled with AlarmKit and ring through Silent mode and Focus, even when O-Alarm is closed."
        ))
      } else {
        items.append(ReadinessItem(
          kind: "engine", status: "warning", title: "Alarm storage locked",
          detail: "Unlock your iPhone once after restarting so O-Alarm can read its alarm list. Alarms already set still ring."
        ))
      }

      let auth = AlarmManager.shared.authorizationState
      if auth == .authorized {
        items.append(ReadinessItem(
          kind: "alarms", status: "ok", title: "Alarms allowed",
          detail: "O-Alarm may schedule system alarms."
        ))
      } else if auth == .notDetermined {
        items.append(ReadinessItem(
          kind: "alarms", status: "blocking", title: "Allow alarms",
          detail: "O-Alarm needs permission to schedule alarms. Without it, nothing will ring.",
          actionType: "request_permission", actionPermission: "alarms"
        ))
      } else {
        items.append(ReadinessItem(
          kind: "alarms", status: "blocking", title: "Alarms are turned off",
          detail: "Alarms for O-Alarm are disabled in Settings, so nothing will ring. Turn them on in Settings.",
          actionType: "open_settings"
        ))
      }

      items.append(ReadinessItem(
        kind: "platform_limitation", status: "warning", title: "Stop button on iPhone",
        detail: "The system Stop button can't require your mission; O-Alarm re-rings if you stop without finishing it."
      ))

      let missing = state.missingSounds.filter { Self.bundledSoundFile($0) == nil }
      if !missing.isEmpty {
        items.append(ReadinessItem(
          kind: "engine", status: "warning", title: "Custom sound unavailable",
          detail: "These sounds aren't installed, so the default alarm sound plays instead: \(missing.joined(separator: ", "))."
        ))
      }

      return Readiness(
        canRing: !items.contains { $0.status == "blocking" },
        checkedAt: EngineTime.iso(Date()),
        items: items
      )
    }
  }

  func requestPermission(_ kind: String) async throws -> String {
    // D4: iOS alarms are AlarmKit only; notifications/exact alarm/etc. don't apply.
    guard kind == "alarms" else { return "unavailable" }
    return try await exclusive {
      var auth = AlarmManager.shared.authorizationState
      if auth == .notDetermined {
        do {
          auth = try await AlarmManager.shared.requestAuthorization()
        } catch {
          throw EngineError(.unknown, "AlarmKit authorization request failed: \(error.localizedDescription)")
        }
      }
      if auth == .authorized { return "granted" }
      if auth == .denied { return "denied" }
      return "undetermined"
    }
  }

  func previewAlarm(_ spec: AlarmSpec) async throws {
    try await exclusive {
      try validate(spec, requireFuture: false)
      try await requireAuthorization(prompt: true)
      try requireLoaded()
      let uuid = UUID()
      state.previews[uuid.uuidString] = spec
      do {
        try await arm(spec, uuid: uuid, at: Date().addingTimeInterval(Self.previewDelay))
      } catch {
        state.previews.removeValue(forKey: uuid.uuidString)
        try? persist()
        throw error
      }
      try persist()
    }
  }

  func getActiveRinging() async throws -> RingingRecord? {
    try await exclusive {
      guard let ringing = state.ringing else { return nil }
      let alerting = UUID(uuidString: ringing.alarmUUID).map { isAlerting($0) } ?? false
      let firedAt = EngineTime.parse(ringing.firedAt) ?? Date()
      if !alerting && Date().timeIntervalSince(firedAt) > Self.staleRingingAge {
        state.ringing = nil
        try? persist()
        return nil
      }
      return ringing
    }
  }

  func snooze(_ scheduleId: String) async throws -> MirrorEntry {
    try await exclusive {
      try requireLoaded()
      let ring = try ringingContext(scheduleId)
      let spec = ring.spec
      let used = state.snoozeCounts[spec.occurrenceKey] ?? 0
      guard spec.snooze.enabled, used < spec.snooze.maxCount else {
        throw EngineError(
          .snoozeLimit,
          "Snooze limit reached (\(used)/\(spec.snooze.enabled ? spec.snooze.maxCount : 0))"
        )
      }
      // Arm first: if AlarmKit refuses, the alarm keeps ringing.
      let entry = try await armSnooze(spec, number: used + 1)
      cancelRetriggers(spec.occurrenceKey)
      await finishRing(ring, reason: "snoozed")
      record("snoozed", spec)
      try? persist()
      AlarmEngineEvents.shared.emit("onSnooze", payload(spec, scheduleId: scheduleId))
      return entry
    }
  }

  func dismiss(_ scheduleId: String, missionCompleted: Bool, wakeCheckAt: String?) async throws -> MirrorEntry? {
    try await exclusive {
      try requireLoaded()
      let ring = try ringingContext(scheduleId)
      let spec = ring.spec
      let key = spec.occurrenceKey
      var wakeCheck: MirrorEntry?
      if let wakeCheckAt {
        // D13: arm the wake check FIRST, so a bad instant leaves the alarm ringing.
        guard let at = EngineTime.parse(wakeCheckAt), at > Date() else {
          throw EngineError(.invalidSpec, "wakeCheckAt \(wakeCheckAt) must be a future ISO-8601 instant")
        }
        let attempt = (state.wakeCheckAttempts[key] ?? 0) + 1
        let wakeSpec = spec.followUp(id: "\(key)#wake-check-\(attempt)", kind: "wake_check", fireAt: wakeCheckAt)
        wakeCheck = try await upsert(wakeSpec)
        state.wakeCheckAttempts[key] = attempt
      }
      cancelRetriggers(key)
      await finishRing(ring, reason: "dismissed")
      state.snoozeCounts.removeValue(forKey: key)
      state.retriggerCounts.removeValue(forKey: key)
      record("dismissed", spec, detail: missionCompleted ? nil : "mission_not_completed")
      try? persist()
      AlarmEngineEvents.shared.emit("onDismiss", payload(spec, scheduleId: scheduleId))
      return wakeCheck
    }
  }

  func drainObservedEvents() async throws -> [ObservedEvent] {
    try await exclusive { state.events }
  }

  func ackObservedEvents(_ ids: [String]) async throws {
    try await exclusive {
      let acked = Set(ids)
      let before = state.events.count
      state.events.removeAll { acked.contains($0.id) }
      if state.events.count != before { try persist() }
    }
  }

  // MARK: - App Intents (run in the app process, possibly with JS dead)

  /// The system Stop button (D14). If the alarm needed an in-app mission or Wake Check,
  /// arm a bounded follow-up `retrigger` alarm.
  func handleSystemStop(alarmID: String) async {
    _ = try? await exclusive {
      guard loaded, let uuid = UUID(uuidString: alarmID), !wasHandled(alarmID),
            let spec = lookupSpec(alarmUUID: uuid)
      else { return }
      let preview = isPreview(alarmID)
      let key = spec.occurrenceKey
      noteTriggered(spec, alarmUUID: alarmID)
      markHandled(alarmID, reason: "system_stop")
      alertingSeen.remove(uuid)

      let needsMission = (spec.hasMissions || spec.wakeCheck) && !preview
      var detail: String?
      var retrigger: MirrorEntry?
      if needsMission {
        let result = await armRetrigger(spec, delay: Self.stopRetriggerDelay, reason: "stop_without_mission")
        retrigger = result
        detail = result == nil ? "retrigger_unavailable" : "mission_not_completed"
      }
      record("stopped_from_system_ui", spec, detail: detail)
      if let retrigger { record("retriggered", retrigger.spec, detail: "stop_without_mission") }

      await retireFired(spec, alarmUUID: alarmID)
      if needsMission {
        // The mission is still owed: keep the ringing record so opening the app routes to /ringing.
        ensureRinging(spec, alarmUUID: alarmID)
      } else {
        clearRinging(occurrenceKey: key)
        state.snoozeCounts.removeValue(forKey: key)
      }
      try? persist()
      var stop = payload(spec, scheduleId: spec.id)
      stop.missionCompleted = !needsMission
      AlarmEngineEvents.shared.emit("onStop", stop)
    }
  }

  /// "Open" (alarms with missions, wake checks, retriggers): the app opens and JS routes to
  /// /ringing via getActiveRinging. A safety retrigger re-rings if the mission isn't finished.
  func handleOpen(alarmID: String) async {
    _ = try? await exclusive {
      guard loaded, let uuid = UUID(uuidString: alarmID), let spec = lookupSpec(alarmUUID: uuid) else { return }
      let preview = isPreview(alarmID)
      let isNew = ensureRinging(spec, alarmUUID: alarmID)
      markHandled(alarmID, reason: "opened")
      try? AlarmManager.shared.stop(id: uuid)
      alertingSeen.remove(uuid)
      if !preview {
        _ = await armRetrigger(spec, delay: Self.openSafetyDelay, reason: "open_without_mission")
      }
      await retireFired(spec, alarmUUID: alarmID)
      try? persist()
      if isNew { AlarmEngineEvents.shared.emit("onTrigger", payload(spec, scheduleId: spec.id)) }
    }
  }

  /// "Snooze" on the system alert (alarms without missions).
  func handleSnoozeIntent(alarmID: String) async {
    _ = try? await exclusive {
      guard loaded, let uuid = UUID(uuidString: alarmID), !wasHandled(alarmID),
            let spec = lookupSpec(alarmUUID: uuid)
      else { return }
      let preview = isPreview(alarmID)
      noteTriggered(spec, alarmUUID: alarmID)
      let used = state.snoozeCounts[spec.occurrenceKey] ?? 0
      if spec.snooze.enabled && used < spec.snooze.maxCount {
        do {
          _ = try await armSnooze(spec, number: used + 1)
        } catch {
          // Keep it ringing rather than silently losing the alarm.
          record("schedule_failed", spec, detail: "snooze: \(EngineError.wrap(error).message)")
          try? persist()
          return
        }
        cancelRetriggers(spec.occurrenceKey)
        markHandled(alarmID, reason: "snoozed")
        try? AlarmManager.shared.stop(id: uuid)
        alertingSeen.remove(uuid)
        record("snoozed", spec)
        await retireFired(spec, alarmUUID: alarmID)
        clearRinging(occurrenceKey: spec.occurrenceKey)
        try? persist()
        AlarmEngineEvents.shared.emit("onSnooze", payload(spec, scheduleId: spec.id))
      } else {
        // The limit was reached after this alert was armed: never silence, ring again shortly.
        markHandled(alarmID, reason: "snooze_limit")
        try? AlarmManager.shared.stop(id: uuid)
        alertingSeen.remove(uuid)
        if !preview, let retrigger = await armRetrigger(spec, delay: Self.stopRetriggerDelay, reason: "snooze_limit") {
          record("retriggered", retrigger.spec, detail: "snooze_limit_reached")
        }
        await retireFired(spec, alarmUUID: alarmID)
        ensureRinging(spec, alarmUUID: alarmID)
        try? persist()
      }
    }
  }

  // MARK: - Observers

  func handleAlarmUpdates() async {
    _ = try? await exclusive {
      guard loaded else { return }
      let alerting = alertingIds()
      alertingSeen.formIntersection(alerting)
      var triggered: [EnginePayload] = []
      for uuid in alerting where !alertingSeen.contains(uuid) && !wasHandled(uuid.uuidString) {
        alertingSeen.insert(uuid)
        guard let spec = lookupSpec(alarmUUID: uuid) else { continue }
        if ensureRinging(spec, alarmUUID: uuid.uuidString) {
          triggered.append(payload(spec, scheduleId: spec.id))
        }
        if spec.kind == "alarm" && !isPreview(uuid.uuidString) {
          await armNextRecurrence(after: spec)
        }
      }
      await reconcileWithOS()
      try? persist()
      for event in triggered {
        AlarmEngineEvents.shared.emit("onTrigger", event)
      }
    }
  }

  func handleClockChange(reason: String) async {
    _ = try? await exclusive {
      await maintenance(reason: reason)
    }
  }

  // MARK: - Internals (lock held)

  private func maintenance(reason: String) async {
    guard loaded else { return }
    await recomputeFloating(reason: reason)
    await reconcileWithOS()
    try? persist()
  }

  private func validate(_ spec: AlarmSpec, requireFuture: Bool) throws {
    func fail(_ message: String) -> EngineError {
      EngineError(.invalidSpec, "Invalid schedule spec \"\(spec.id)\": \(message)")
    }
    let blank = { (value: String) in value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    if blank(spec.id) { throw fail("id is empty") }
    if blank(spec.alarmId) { throw fail("alarmId is empty") }
    if blank(spec.occurrenceKey) { throw fail("occurrenceKey is empty") }
    guard scheduleKinds.contains(spec.kind) else { throw fail("unknown kind \(spec.kind)") }
    guard soundKinds.contains(spec.sound.kind) else { throw fail("unknown sound kind \(spec.sound.kind)") }
    guard let fireAt = EngineTime.parse(spec.fireAt) else { throw fail("fireAt \(spec.fireAt) is not ISO-8601") }
    if requireFuture && fireAt <= Date() { throw fail("fireAt \(spec.fireAt) is in the past") }
    guard spec.snooze.maxCount >= 0, spec.snooze.maxCount <= 100 else { throw fail("snooze.maxCount out of range") }
    if spec.snooze.enabled && !(spec.snooze.durationMin > 0 && spec.snooze.durationMin <= 1440) {
      throw fail("snooze.durationMin out of range")
    }
    guard spec.escalation.rampSeconds >= 0 else { throw fail("escalation.rampSeconds is negative") }
    if let wallClock = spec.wallClock {
      guard (0...23).contains(wallClock.hour), (0...59).contains(wallClock.minute) else {
        throw fail("wallClock time out of range")
      }
      guard EngineTime.CivilDate.parse(wallClock.localDate) != nil else { throw fail("wallClock.localDate is invalid") }
      if let zone = wallClock.timeZone, TimeZone(identifier: zone) == nil {
        throw fail("unknown time zone \(zone)")
      }
      guard wallClock.weekdays.allSatisfy({ (0...6).contains($0) }) else { throw fail("weekdays must be 0-6") }
    }
  }

  private func requireAuthorization(prompt: Bool) async throws {
    var auth = AlarmManager.shared.authorizationState
    if auth == .notDetermined && prompt {
      auth = (try? await AlarmManager.shared.requestAuthorization()) ?? .notDetermined
    }
    guard auth == .authorized else {
      throw EngineError(
        .permissionDenied,
        auth == .denied ? "Alarms are disabled for O-Alarm in Settings" : "Alarm permission has not been granted"
      )
    }
  }

  private func osAlarms() -> [Alarm]? {
    try? AlarmManager.shared.alarms
  }

  private func alertingIds() -> Set<UUID> {
    Set((osAlarms() ?? []).filter { alarm in
      if case .alerting = alarm.state { return true }
      return false
    }.map(\.id))
  }

  private func isAlerting(_ uuid: UUID) -> Bool {
    guard let alarm = osAlarms()?.first(where: { $0.id == uuid }) else { return false }
    if case .alerting = alarm.state { return true }
    return false
  }

  /// Mirror + preview + ringing lookup by AlarmKit id.
  private func lookupSpec(alarmUUID uuid: UUID) -> AlarmSpec? {
    if let preview = state.previews[uuid.uuidString] { return preview }
    if let entry = state.entries.values.first(where: { EngineTime.alarmUUID(for: $0.spec.id) == uuid }) {
      return entry.spec
    }
    if let ringing = state.ringing, ringing.alarmUUID == uuid.uuidString { return ringing.spec }
    return state.fired[uuid.uuidString]?.spec
  }

  private func isPreview(_ alarmUUID: String) -> Bool {
    state.previews[alarmUUID] != nil || state.fired[alarmUUID]?.preview == true
  }

  private func ringingContext(_ scheduleId: String) throws -> RingContext {
    if let ringing = state.ringing,
       ringing.scheduleId == scheduleId || ringing.supersededIds.contains(scheduleId) {
      return RingContext(spec: ringing.spec, alarmUUID: ringing.alarmUUID)
    }
    // Alerting in AlarmKit but not the recorded ring (e.g. two alarms at the same minute).
    let uuid = EngineTime.alarmUUID(for: scheduleId)
    if let entry = state.entries[scheduleId], isAlerting(uuid) {
      return RingContext(spec: entry.spec, alarmUUID: uuid.uuidString)
    }
    throw EngineError(.notRinging, "\"\(scheduleId)\" is not ringing")
  }

  /// Records the ring once and makes it the active ringing record. Returns true if new.
  @discardableResult
  private func ensureRinging(_ spec: AlarmSpec, alarmUUID: String) -> Bool {
    if let ringing = state.ringing, ringing.alarmUUID == alarmUUID { return false }
    let now = Date()
    let fireAt = EngineTime.parse(spec.fireAt) ?? now
    var superseded: [String] = []
    if let ringing = state.ringing, ringing.occurrenceKey == spec.occurrenceKey {
      superseded = ringing.supersededIds + [ringing.scheduleId]
    }
    noteTriggered(spec, alarmUUID: alarmUUID)
    state.ringing = RingingRecord(
      scheduleId: spec.id,
      alarmId: spec.alarmId,
      occurrenceKey: spec.occurrenceKey,
      kind: spec.kind,
      at: EngineTime.iso(now),
      firedAt: EngineTime.iso(min(fireAt, now)),
      snoozeCount: state.snoozeCounts[spec.occurrenceKey] ?? 0,
      label: spec.label,
      hasMissions: spec.hasMissions,
      wakeCheck: spec.wakeCheck,
      important: spec.important,
      spec: spec,
      alarmUUID: alarmUUID,
      supersededIds: superseded.filter { $0 != spec.id }
    )
    return true
  }

  /// Logs `trigger_received` once per ring, even if the alert was never observed (JS dead).
  private func noteTriggered(_ spec: AlarmSpec, alarmUUID: String) {
    guard state.triggered[alarmUUID] == nil else { return }
    state.triggered[alarmUUID] = EngineTime.iso(Date())
    record("trigger_received", spec)
  }

  private func clearRinging(occurrenceKey: String) {
    if state.ringing?.occurrenceKey == occurrenceKey {
      state.ringing = nil
    }
  }

  private func markHandled(_ alarmUUID: String, reason: String) {
    state.handled[alarmUUID] = HandledMark(reason: reason, at: EngineTime.iso(Date()))
  }

  private func wasHandled(_ alarmUUID: String) -> Bool {
    guard let mark = state.handled[alarmUUID], let at = EngineTime.parse(mark.at) else { return false }
    return Date().timeIntervalSince(at) < Self.handledWindow
  }

  /// Ends an in-app handled ring: stop the system alert, arm the next recurrence, retire it.
  private func finishRing(_ ring: RingContext, reason: String) async {
    markHandled(ring.alarmUUID, reason: reason)
    if let uuid = UUID(uuidString: ring.alarmUUID) {
      try? AlarmManager.shared.stop(id: uuid)
      alertingSeen.remove(uuid)
    }
    await retireFired(ring.spec, alarmUUID: ring.alarmUUID)
    clearRinging(occurrenceKey: ring.spec.occurrenceKey)
  }

  /// A one-shot alarm that rang leaves the mirror (and AlarmKit). Recurring alarms arm their
  /// next occurrence first (D28).
  private func retireFired(_ spec: AlarmSpec, alarmUUID: String) async {
    if state.previews.removeValue(forKey: alarmUUID) != nil {
      state.fired[alarmUUID] = FiredRecord(spec: spec, preview: true, at: EngineTime.iso(Date()))
      return
    }
    if state.fired[alarmUUID] == nil {
      state.fired[alarmUUID] = FiredRecord(spec: spec, preview: false, at: EngineTime.iso(Date()))
    }
    if spec.kind == "alarm" {
      await armNextRecurrence(after: spec)
    }
    if let entry = state.entries[spec.id], EngineTime.alarmUUID(for: entry.spec.id).uuidString == alarmUUID {
      state.entries.removeValue(forKey: spec.id)
    }
  }

  private func cancelRetriggers(_ occurrenceKey: String) {
    let pending = state.entries.values.filter {
      $0.spec.kind == "retrigger" && $0.spec.occurrenceKey == occurrenceKey
    }
    for entry in pending {
      let uuid = EngineTime.alarmUUID(for: entry.spec.id)
      guard !isAlerting(uuid) else { continue }
      try? AlarmManager.shared.cancel(id: uuid)
      state.entries.removeValue(forKey: entry.spec.id)
    }
  }

  private func armSnooze(_ spec: AlarmSpec, number: Int) async throws -> MirrorEntry {
    let key = spec.occurrenceKey
    let fireAt = Date().addingTimeInterval(spec.snooze.durationMin * 60)
    let snoozeSpec = spec.followUp(id: "\(key)#snooze-\(number)", kind: "snooze", fireAt: EngineTime.iso(fireAt))
    let previous = state.snoozeCounts[key]
    // Count first, so the snooze alert only offers Snooze again while snoozes remain.
    state.snoozeCounts[key] = number
    do {
      return try await upsert(snoozeSpec)
    } catch {
      state.snoozeCounts[key] = previous
      throw error
    }
  }

  /// Arms `<occurrenceKey>#retrigger-<n>` if the bound allows. Failures are logged.
  private func armRetrigger(_ spec: AlarmSpec, delay: TimeInterval, reason: String) async -> MirrorEntry? {
    let key = spec.occurrenceKey
    let number = (state.retriggerCounts[key] ?? 0) + 1
    guard number <= Self.maxRetriggers else { return nil }
    let fireAt = EngineTime.iso(Date().addingTimeInterval(delay))
    let retriggerSpec = spec.followUp(id: "\(key)#retrigger-\(number)", kind: "retrigger", fireAt: fireAt)
    do {
      let entry = try await upsert(retriggerSpec)
      state.retriggerCounts[key] = number
      return entry
    } catch {
      record("schedule_failed", retriggerSpec, detail: "\(reason): \(EngineError.wrap(error).message)")
      return nil
    }
  }

  /// D28: arm the occurrence after the alarm's LATEST mirrored `alarm` entry, once per fired id.
  private func armNextRecurrence(after fired: AlarmSpec) async {
    guard fired.kind == "alarm", state.rearmed[fired.id] == nil else { return }
    let siblings = state.entries.values.map(\.spec).filter {
      $0.alarmId == fired.alarmId && $0.kind == "alarm" && $0.wallClock != nil
    }
    guard let latest = (siblings + [fired]).filter({ $0.wallClock != nil })
      .max(by: { $0.wallClock!.localDate < $1.wallClock!.localDate }),
      let wallClock = latest.wallClock,
      !wallClock.weekdays.isEmpty,
      let latestDate = EngineTime.CivilDate.parse(wallClock.localDate)
    else { return }
    state.rearmed[fired.id] = EngineTime.iso(Date())

    let zone = wallClock.timeZone.flatMap { TimeZone(identifier: $0) } ?? EngineTime.deviceTimeZone()
    let now = Date()
    var date = latestDate
    for _ in 0..<400 {
      date = date.adding(days: 1)
      guard wallClock.weekdays.contains(date.weekday) else { continue }
      let fire = EngineTime.resolveWallClock(date, hour: wallClock.hour, minute: wallClock.minute, zone: zone)
      guard fire > now else { continue }
      // Same id format as JS (src/domain/recurrence.ts occurrenceKey), so reconcile replaces it.
      let key = "\(latest.alarmId)@\(date.formatted)"
      guard state.entries[key] == nil else { return }
      var next = latest
      next.id = key
      next.occurrenceKey = key
      next.fireAt = EngineTime.iso(fire)
      next.wallClock?.localDate = date.formatted
      do {
        try await upsert(next)
      } catch {
        record("schedule_failed", next, detail: "next_occurrence: \(EngineError.wrap(error).message)")
      }
      return
    }
  }

  /// Floating alarms follow the device zone (D9). Runs on launch and clock/zone changes.
  private func recomputeFloating(reason: String) async {
    let zone = EngineTime.deviceTimeZone()
    let now = Date()
    for entry in Array(state.entries.values) where entry.spec.kind == "alarm" {
      guard let wallClock = entry.spec.wallClock, wallClock.timeZone == nil,
            let date = EngineTime.CivilDate.parse(wallClock.localDate),
            let current = EngineTime.parse(entry.spec.fireAt)
      else { continue }
      let uuid = EngineTime.alarmUUID(for: entry.spec.id)
      guard current > now, !isAlerting(uuid) else { continue }
      let fire = EngineTime.resolveWallClock(date, hour: wallClock.hour, minute: wallClock.minute, zone: zone)
      guard abs(fire.timeIntervalSince(current)) >= 1 else { continue }
      var spec = entry.spec
      spec.fireAt = EngineTime.iso(fire)
      if fire <= now {
        try? AlarmManager.shared.cancel(id: uuid)
        state.entries.removeValue(forKey: spec.id)
        record("missed", spec, detail: "\(reason): recomputed into the past in \(zone.identifier)")
        await armNextRecurrence(after: spec)
        continue
      }
      do {
        try await upsert(spec)
        record("tz_change_rescheduled", spec, detail: "\(reason): \(zone.identifier)")
      } catch {
        record("schedule_failed", spec, detail: "\(reason): \(EngineError.wrap(error).message)")
      }
    }
  }

  /// Keeps the mirror honest against AlarmKit: entries that fired leave it (arming the next
  /// recurrence), entries AlarmKit lost before firing are re-armed.
  private func reconcileWithOS() async {
    guard let alarms = osAlarms() else { return }
    let held = Set(alarms.map(\.id))
    let now = Date()
    for entry in Array(state.entries.values) {
      let uuid = EngineTime.alarmUUID(for: entry.spec.id)
      guard !held.contains(uuid) else { continue }
      let fireAt = EngineTime.parse(entry.spec.fireAt) ?? now
      if fireAt <= now.addingTimeInterval(1) {
        await retireFired(entry.spec, alarmUUID: uuid.uuidString)
      } else {
        do {
          try await upsert(entry.spec)
        } catch {
          state.entries.removeValue(forKey: entry.spec.id)
          record("schedule_failed", entry.spec, detail: "rearm_lost: \(EngineError.wrap(error).message)")
        }
      }
    }
    state.previews = state.previews.filter { key, _ in
      guard let uuid = UUID(uuidString: key) else { return false }
      return held.contains(uuid) || state.ringing?.alarmUUID == key
    }
  }

  /// Idempotent upsert keyed by spec.id: cancel the deterministic AlarmKit id, then schedule.
  @discardableResult
  private func upsert(_ spec: AlarmSpec) async throws -> MirrorEntry {
    guard let fireDate = EngineTime.parse(spec.fireAt) else {
      throw EngineError(.invalidSpec, "fireAt \(spec.fireAt) is not ISO-8601")
    }
    let uuid = EngineTime.alarmUUID(for: spec.id)
    if isAlerting(uuid) {
      throw EngineError(.scheduleFailed, "\"\(spec.id)\" is ringing now; dismiss or snooze it first")
    }
    do {
      try await arm(spec, uuid: uuid, at: fireDate)
    } catch {
      // The previous alarm was cancelled: the mirror must not claim it is armed.
      state.entries.removeValue(forKey: spec.id)
      try? persist()
      throw error
    }
    let entry = MirrorEntry(spec: spec, scheduledAt: EngineTime.iso(Date()))
    state.entries[spec.id] = entry
    try persist()
    return entry
  }

  private func arm(_ spec: AlarmSpec, uuid: UUID, at date: Date) async throws {
    try? AlarmManager.shared.cancel(id: uuid)
    let configuration = makeConfiguration(spec, uuid: uuid, at: date)
    do {
      _ = try await AlarmManager.shared.schedule(id: uuid, configuration: configuration)
    } catch {
      throw EngineError(.scheduleFailed, "AlarmKit could not schedule \"\(spec.id)\": \(error.localizedDescription)")
    }
  }

  private func secondaryAction(for spec: AlarmSpec) -> SecondaryAction {
    // Mission alarms and follow-ups that need the app (wake check, retrigger) open it.
    if spec.hasMissions || spec.kind == "wake_check" || spec.kind == "retrigger" { return .open }
    let used = state.snoozeCounts[spec.occurrenceKey] ?? 0
    if spec.snooze.enabled && used < spec.snooze.maxCount { return .snooze }
    return .none
  }

  private func makeConfiguration(
    _ spec: AlarmSpec,
    uuid: UUID,
    at date: Date
  ) -> AlarmManager.AlarmConfiguration<AlarmEngineMetadata> {
    let alarmID = uuid.uuidString
    var secondaryButton: AlarmButton?
    var secondaryBehavior: AlarmPresentation.Alert.SecondaryButtonBehavior?
    var secondaryIntent: (any LiveActivityIntent)?
    switch secondaryAction(for: spec) {
    case .open:
      secondaryButton = AlarmButton(text: "Open", textColor: .white, systemImageName: "arrow.up.forward.app")
      secondaryBehavior = .custom
      secondaryIntent = AlarmEngineOpenIntent(alarmID: alarmID, scheduleId: spec.id)
    case .snooze:
      secondaryButton = AlarmButton(text: "Snooze", textColor: .white, systemImageName: "zzz")
      secondaryBehavior = .custom
      secondaryIntent = AlarmEngineSnoozeIntent(alarmID: alarmID, scheduleId: spec.id)
    case .none:
      break
    }

    let label = spec.label.trimmingCharacters(in: .whitespacesAndNewlines)
    let title = LocalizedStringResource(stringLiteral: label.isEmpty ? "Alarm" : label)
    let alert: AlarmPresentation.Alert
    if #available(iOS 26.1, *) {
      // 26.1+: the system provides the Stop control.
      alert = AlarmPresentation.Alert(
        title: title,
        secondaryButton: secondaryButton,
        secondaryButtonBehavior: secondaryBehavior
      )
    } else {
      alert = AlarmPresentation.Alert(
        title: title,
        stopButton: AlarmButton(text: "Stop", textColor: .white, systemImageName: "stop.circle"),
        secondaryButton: secondaryButton,
        secondaryButtonBehavior: secondaryBehavior
      )
    }
    let attributes = AlarmAttributes<AlarmEngineMetadata>(
      presentation: AlarmPresentation(alert: alert, countdown: nil, paused: nil),
      metadata: AlarmEngineMetadata(),
      tintColor: Color.orange
    )
    return AlarmManager.AlarmConfiguration<AlarmEngineMetadata>.alarm(
      schedule: .fixed(date),
      attributes: attributes,
      stopIntent: AlarmEngineStopIntent(alarmID: alarmID, scheduleId: spec.id),
      secondaryIntent: secondaryIntent,
      sound: alertSound(for: spec)
    )
  }

  private func alertSound(for spec: AlarmSpec) -> AlertConfiguration.AlertSound {
    guard spec.sound.kind == "custom", let id = spec.sound.id, !id.isEmpty else { return .default }
    if let file = Self.bundledSoundFile(id) {
      state.missingSounds.removeAll { $0 == id }
      return .named(file)
    }
    if !state.missingSounds.contains(id) { state.missingSounds.append(id) }
    return .default
  }

  /// The file name AlarmKit can play for a custom sound id: main bundle or Library/Sounds.
  static func bundledSoundFile(_ id: String) -> String? {
    let name = id as NSString
    let candidates = name.pathExtension.isEmpty
      ? ["caf", "wav", "aiff", "aif", "m4a", "mp3"].map { "\(id).\($0)" }
      : [id]
    let soundsDirectory = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask).first?
      .appendingPathComponent("Sounds", isDirectory: true)
    for file in candidates {
      let base = (file as NSString).deletingPathExtension
      let ext = (file as NSString).pathExtension
      if Bundle.main.path(forResource: base, ofType: ext) != nil { return file }
      if let soundsDirectory,
         FileManager.default.fileExists(atPath: soundsDirectory.appendingPathComponent(file).path) {
        return file
      }
    }
    return nil
  }

  private func payload(_ spec: AlarmSpec, scheduleId: String) -> EnginePayload {
    EnginePayload(
      scheduleId: scheduleId,
      alarmId: spec.alarmId,
      occurrenceKey: spec.occurrenceKey,
      kind: spec.kind,
      at: EngineTime.iso(Date()),
      missionCompleted: nil
    )
  }

  private func record(_ type: String, _ spec: AlarmSpec, detail: String? = nil) {
    record(type, scheduleId: spec.id, alarmId: spec.alarmId, occurrenceKey: spec.occurrenceKey, detail: detail)
  }

  private func record(_ type: String, scheduleId: String, alarmId: String, occurrenceKey: String, detail: String?) {
    state.events.append(ObservedEvent(
      id: UUID().uuidString,
      type: type,
      scheduleId: scheduleId,
      alarmId: alarmId,
      occurrenceKey: occurrenceKey,
      at: EngineTime.iso(Date()),
      detail: detail
    ))
  }
}
