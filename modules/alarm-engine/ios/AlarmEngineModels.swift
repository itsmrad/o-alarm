import ExpoModulesCore
import Foundation

// Wire + persisted models for the AlarmKit engine. Field names match
// modules/alarm-engine/src/AlarmEngine.types.ts exactly; the JS fingerprint
// (src/engine/specs.ts) compares the read-back, so every field round-trips verbatim.

let scheduleKinds: Set<String> = ["alarm", "snooze", "wake_check", "retrigger"]
let soundKinds: Set<String> = ["default", "system", "custom"]

// MARK: - Errors

/// The only error codes JS understands (AlarmEngineError.from).
enum EngineErrorCode: String {
  case permissionDenied = "PERMISSION_DENIED"
  case invalidSpec = "INVALID_SPEC"
  case scheduleFailed = "SCHEDULE_FAILED"
  case snoozeLimit = "SNOOZE_LIMIT"
  case notRinging = "NOT_RINGING"
  case unknown = "UNKNOWN"
}

struct EngineError: Error, CustomStringConvertible {
  let code: EngineErrorCode
  let message: String

  init(_ code: EngineErrorCode, _ message: String) {
    self.code = code
    self.message = message
  }

  var description: String { "\(code.rawValue): \(message)" }

  /// Rejects the JS promise with `code` (no `ERR_` prefix) and the message.
  var exception: Exception {
    Exception(name: "AlarmEngineError", description: message, code: code.rawValue)
  }

  static func wrap(_ error: Error) -> EngineError {
    if let error = error as? EngineError { return error }
    return EngineError(.unknown, String(describing: error))
  }
}

// MARK: - Spec

struct WallClock: Codable, Equatable, Sendable {
  var hour: Int
  var minute: Int
  var localDate: String
  /// nil = floating (device zone).
  var timeZone: String?
  /// 0 = Sunday … 6 = Saturday; empty = one-time.
  var weekdays: [Int]
}

struct SoundSpec: Codable, Equatable, Sendable {
  var kind: String
  var id: String?
}

struct EscalationSpec: Codable, Equatable, Sendable {
  var enabled: Bool
  var rampSeconds: Double
}

struct SnoozeSpec: Codable, Equatable, Sendable {
  var enabled: Bool
  var durationMin: Double
  var maxCount: Int
}

struct AlarmSpec: Codable, Equatable, Sendable {
  var id: String
  var alarmId: String
  var occurrenceKey: String
  var kind: String
  var fireAt: String
  var wallClock: WallClock?
  var label: String
  var sound: SoundSpec
  var vibration: Bool
  var escalation: EscalationSpec
  var snooze: SnoozeSpec
  var hasMissions: Bool
  var wakeCheck: Bool
  var important: Bool

  /// Snooze / wake-check / retrigger follow-ups are instant-only (D28): no wall-clock rule.
  func followUp(id: String, kind: String, fireAt: String) -> AlarmSpec {
    var copy = self
    copy.id = id
    copy.kind = kind
    copy.fireAt = fireAt
    copy.wallClock = nil
    return copy
  }
}

/// A mirror entry: the spec verbatim + when it was armed (D10).
struct MirrorEntry: Codable, Sendable {
  var spec: AlarmSpec
  var scheduledAt: String
}

/// RingingState in AlarmEngine.types.ts, plus the spec it came from.
struct RingingRecord: Codable, Sendable {
  var scheduleId: String
  var alarmId: String
  var occurrenceKey: String
  var kind: String
  var at: String
  var firedAt: String
  var snoozeCount: Int
  var label: String
  var hasMissions: Bool
  var wakeCheck: Bool
  var important: Bool
  var spec: AlarmSpec
  /// The AlarmKit id that rang (random for previews).
  var alarmUUID: String
  /// Earlier schedule ids of the same occurrence that this ring superseded (e.g. a safety
  /// retrigger fired while the mission was open). dismiss/snooze accept them too.
  var supersededIds: [String]
}

struct ObservedEvent: Codable, Sendable {
  var id: String
  var type: String
  var scheduleId: String
  var alarmId: String
  var occurrenceKey: String
  var at: String
  var detail: String?
}

/// Why a schedule id was stopped by the engine itself, so a Stop intent that the system
/// may run for our own `stop(id:)` call is not mistaken for the user's system Stop button.
struct HandledMark: Codable, Sendable {
  var reason: String
  var at: String
}

/// A ring that left the mirror, kept briefly so a late Stop/Open intent can still find it.
struct FiredRecord: Codable, Sendable {
  var spec: AlarmSpec
  var preview: Bool
  var at: String
}

/// Everything the engine persists, in one atomically written file.
struct EngineState: Codable, Sendable {
  var entries: [String: MirrorEntry] = [:]
  /// Preview rings by AlarmKit UUID string; never part of getScheduled.
  var previews: [String: AlarmSpec] = [:]
  var ringing: RingingRecord?
  var events: [ObservedEvent] = []
  /// Per occurrenceKey.
  var snoozeCounts: [String: Int] = [:]
  var wakeCheckAttempts: [String: Int] = [:]
  var retriggerCounts: [String: Int] = [:]
  var handled: [String: HandledMark] = [:]
  /// Custom sound ids that are not in the app bundle (readiness warning).
  var missingSounds: [String] = []
  /// Fired `alarm` schedule ids whose next recurrence was already armed (D28) → when.
  var rearmed: [String: String] = [:]
  /// AlarmKit ids whose `trigger_received` is logged → when.
  var triggered: [String: String] = [:]
  /// Recently fired rings by AlarmKit id.
  var fired: [String: FiredRecord] = [:]

  init() {}

  // Tolerant decoding: a field added in a later version must not wipe the mirror.
  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    entries = try c.decodeIfPresent([String: MirrorEntry].self, forKey: .entries) ?? [:]
    previews = try c.decodeIfPresent([String: AlarmSpec].self, forKey: .previews) ?? [:]
    ringing = try c.decodeIfPresent(RingingRecord.self, forKey: .ringing)
    events = try c.decodeIfPresent([ObservedEvent].self, forKey: .events) ?? []
    snoozeCounts = try c.decodeIfPresent([String: Int].self, forKey: .snoozeCounts) ?? [:]
    wakeCheckAttempts = try c.decodeIfPresent([String: Int].self, forKey: .wakeCheckAttempts) ?? [:]
    retriggerCounts = try c.decodeIfPresent([String: Int].self, forKey: .retriggerCounts) ?? [:]
    handled = try c.decodeIfPresent([String: HandledMark].self, forKey: .handled) ?? [:]
    missingSounds = try c.decodeIfPresent([String].self, forKey: .missingSounds) ?? []
    rearmed = try c.decodeIfPresent([String: String].self, forKey: .rearmed) ?? [:]
    triggered = try c.decodeIfPresent([String: String].self, forKey: .triggered) ?? [:]
    fired = try c.decodeIfPresent([String: FiredRecord].self, forKey: .fired) ?? [:]
  }
}

// MARK: - JS → native

private func invalid(_ message: String) -> EngineError {
  EngineError(.invalidSpec, message)
}

private func isNull(_ value: Any?) -> Bool {
  value == nil || value is NSNull
}

private func readString(_ dict: [String: Any], _ key: String, path: String) throws -> String {
  guard let value = dict[key] as? String else { throw invalid("\(path)\(key) must be a string") }
  return value
}

private func readBool(_ dict: [String: Any], _ key: String, path: String) throws -> Bool {
  if let value = dict[key] as? Bool { return value }
  throw invalid("\(path)\(key) must be a boolean")
}

private func readNumber(_ dict: [String: Any], _ key: String, path: String) throws -> Double {
  let raw = dict[key]
  let number: Double?
  if let value = raw as? Double {
    number = value
  } else if let value = raw as? Int {
    number = Double(value)
  } else if let value = raw as? NSNumber {
    number = value.doubleValue
  } else {
    number = nil
  }
  guard let number, number.isFinite else { throw invalid("\(path)\(key) must be a finite number") }
  return number
}

private func readInt(_ dict: [String: Any], _ key: String, path: String) throws -> Int {
  let number = try readNumber(dict, key, path: path)
  guard number.rounded() == number, abs(number) < 1e9 else {
    throw invalid("\(path)\(key) must be an integer")
  }
  return Int(number)
}

private func readObject(_ dict: [String: Any], _ key: String, path: String) throws -> [String: Any] {
  guard let value = dict[key] as? [String: Any] else { throw invalid("\(path)\(key) must be an object") }
  return value
}

extension AlarmSpec {
  /// Parses the JS `AlarmScheduleSpec`. Shape errors → INVALID_SPEC; semantic checks are
  /// in `AlarmEngineCore.validate`.
  init(wire dict: [String: Any]) throws {
    id = try readString(dict, "id", path: "")
    alarmId = try readString(dict, "alarmId", path: "")
    occurrenceKey = try readString(dict, "occurrenceKey", path: "")
    kind = try readString(dict, "kind", path: "")
    fireAt = try readString(dict, "fireAt", path: "")
    label = try readString(dict, "label", path: "")
    vibration = try readBool(dict, "vibration", path: "")
    hasMissions = try readBool(dict, "hasMissions", path: "")
    wakeCheck = try readBool(dict, "wakeCheck", path: "")
    important = try readBool(dict, "important", path: "")

    let soundDict = try readObject(dict, "sound", path: "")
    let soundId = soundDict["id"]
    guard isNull(soundId) || soundId is String else { throw invalid("sound.id must be a string or null") }
    sound = SoundSpec(kind: try readString(soundDict, "kind", path: "sound."), id: soundId as? String)

    let escalationDict = try readObject(dict, "escalation", path: "")
    escalation = EscalationSpec(
      enabled: try readBool(escalationDict, "enabled", path: "escalation."),
      rampSeconds: try readNumber(escalationDict, "rampSeconds", path: "escalation.")
    )

    let snoozeDict = try readObject(dict, "snooze", path: "")
    snooze = SnoozeSpec(
      enabled: try readBool(snoozeDict, "enabled", path: "snooze."),
      durationMin: try readNumber(snoozeDict, "durationMin", path: "snooze."),
      maxCount: try readInt(snoozeDict, "maxCount", path: "snooze.")
    )

    if isNull(dict["wallClock"]) {
      wallClock = nil
    } else {
      let wc = try readObject(dict, "wallClock", path: "")
      let zone = wc["timeZone"]
      guard isNull(zone) || zone is String else { throw invalid("wallClock.timeZone must be a string or null") }
      guard let rawWeekdays = wc["weekdays"] as? [Any] else { throw invalid("wallClock.weekdays must be an array") }
      let weekdays: [Int] = try rawWeekdays.map { value in
        try readInt(["d": value], "d", path: "wallClock.weekdays.")
      }
      wallClock = WallClock(
        hour: try readInt(wc, "hour", path: "wallClock."),
        minute: try readInt(wc, "minute", path: "wallClock."),
        localDate: try readString(wc, "localDate", path: "wallClock."),
        timeZone: zone as? String,
        weekdays: weekdays
      )
    }
  }

  // MARK: native → JS

  /// Plain Swift values (Bool/Int/Double/String/NSNull) so Expo converts them exactly.
  var wire: [String: Any] {
    var dict: [String: Any] = [
      "id": id,
      "alarmId": alarmId,
      "occurrenceKey": occurrenceKey,
      "kind": kind,
      "fireAt": fireAt,
      "label": label,
      "sound": ["kind": sound.kind, "id": sound.id.map { $0 as Any } ?? NSNull()] as [String: Any],
      "vibration": vibration,
      "escalation": ["enabled": escalation.enabled, "rampSeconds": escalation.rampSeconds] as [String: Any],
      "snooze": [
        "enabled": snooze.enabled,
        "durationMin": snooze.durationMin,
        "maxCount": snooze.maxCount,
      ] as [String: Any],
      "hasMissions": hasMissions,
      "wakeCheck": wakeCheck,
      "important": important,
    ]
    if let wallClock {
      dict["wallClock"] = [
        "hour": wallClock.hour,
        "minute": wallClock.minute,
        "localDate": wallClock.localDate,
        "timeZone": wallClock.timeZone.map { $0 as Any } ?? NSNull(),
        "weekdays": wallClock.weekdays,
      ] as [String: Any]
    }
    return dict
  }
}

extension MirrorEntry {
  /// `ScheduledAlarm`.
  var wire: [String: Any] {
    var dict = spec.wire
    dict["scheduledAt"] = scheduledAt
    return dict
  }
}

extension RingingRecord {
  /// `RingingState`.
  var wire: [String: Any] {
    [
      "scheduleId": scheduleId,
      "alarmId": alarmId,
      "occurrenceKey": occurrenceKey,
      "kind": kind,
      "at": at,
      "firedAt": firedAt,
      "snoozeCount": snoozeCount,
      "label": label,
      "hasMissions": hasMissions,
      "wakeCheck": wakeCheck,
      "important": important,
    ]
  }
}

extension ObservedEvent {
  var wire: [String: Any] {
    var dict: [String: Any] = [
      "id": id,
      "type": type,
      "scheduleId": scheduleId,
      "alarmId": alarmId,
      "occurrenceKey": occurrenceKey,
      "at": at,
    ]
    if let detail { dict["detail"] = detail }
    return dict
  }
}

/// Payload for onTrigger / onSnooze / onDismiss (+ missionCompleted for onStop).
struct EnginePayload: Sendable {
  var scheduleId: String
  var alarmId: String
  var occurrenceKey: String
  var kind: String
  var at: String
  var missionCompleted: Bool?

  var wire: [String: Any] {
    var dict: [String: Any] = [
      "scheduleId": scheduleId,
      "alarmId": alarmId,
      "occurrenceKey": occurrenceKey,
      "kind": kind,
      "at": at,
    ]
    if let missionCompleted { dict["missionCompleted"] = missionCompleted }
    return dict
  }
}

// MARK: - Readiness

struct ReadinessItem: Sendable {
  var kind: String
  var status: String
  var title: String
  var detail: String
  /// nil, ("request_permission", permission) or ("open_settings", nil).
  var actionType: String?
  var actionPermission: String?

  var wire: [String: Any] {
    var action: Any = NSNull()
    if let actionType {
      var dict: [String: Any] = ["type": actionType]
      if let actionPermission { dict["permission"] = actionPermission }
      action = dict
    }
    return ["kind": kind, "status": status, "title": title, "detail": detail, "action": action]
  }
}

struct Readiness: Sendable {
  var canRing: Bool
  var checkedAt: String
  var items: [ReadinessItem]

  var wire: [String: Any] {
    ["engine": "native", "canRing": canRing, "checkedAt": checkedAt, "items": items.map { $0.wire }]
  }
}
