import ExpoModulesCore

/// Native alarm engine (AlarmKit, D4). A thin bridge: every call goes to `AlarmEngineCore`,
/// and every failure rejects with a typed code (PERMISSION_DENIED, INVALID_SPEC,
/// SCHEDULE_FAILED, SNOOZE_LIMIT, NOT_RINGING, UNKNOWN). Never fakes success.
public class AlarmEngineModule: Module {
  public func definition() -> ModuleDefinition {
    Name("AlarmEngine")

    Events("onTrigger", "onSnooze", "onDismiss", "onStop")

    OnCreate {
      AlarmEngineEvents.shared.setSink { [weak self] name, body in
        self?.sendEvent(name, body.mapValues { Optional($0) })
      }
      // Loads the mirror, recomputes floating alarms (D9) and starts observing AlarmKit.
      Task { await AlarmEngineCore.shared.start() }
    }

    OnDestroy {
      AlarmEngineEvents.shared.setSink(nil)
    }

    AsyncFunction("schedule") { (wire: [String: Any]) async throws -> [String: Any] in
      let spec = try parseSpec(wire)
      return try await bridged { try await AlarmEngineCore.shared.schedule(spec) }.wire
    }

    AsyncFunction("cancel") { (id: String) async throws in
      try await bridged { try await AlarmEngineCore.shared.cancel(id) }
    }

    AsyncFunction("cancelAll") { () async throws in
      try await bridged { try await AlarmEngineCore.shared.cancelAll() }
    }

    AsyncFunction("getScheduled") { () async throws -> [[String: Any]] in
      try await bridged { try await AlarmEngineCore.shared.getScheduled() }.map { $0.wire }
    }

    AsyncFunction("getReadiness") { () async throws -> [String: Any] in
      try await bridged { try await AlarmEngineCore.shared.getReadiness() }.wire
    }

    AsyncFunction("requestPermission") { (kind: String) async throws -> String in
      try await bridged { try await AlarmEngineCore.shared.requestPermission(kind) }
    }

    AsyncFunction("previewAlarm") { (wire: [String: Any]) async throws in
      let spec = try parseSpec(wire)
      try await bridged { try await AlarmEngineCore.shared.previewAlarm(spec) }
    }

    AsyncFunction("getActiveRinging") { () async throws -> [String: Any]? in
      try await bridged { try await AlarmEngineCore.shared.getActiveRinging() }?.wire
    }

    AsyncFunction("snooze") { (scheduleId: String) async throws -> [String: Any] in
      try await bridged { try await AlarmEngineCore.shared.snooze(scheduleId) }.wire
    }

    AsyncFunction("dismiss") { (scheduleId: String, options: [String: Any]) async throws -> [String: Any] in
      guard let missionCompleted = options["missionCompleted"] as? Bool else {
        throw EngineError(.invalidSpec, "options.missionCompleted must be a boolean").exception
      }
      let rawWakeCheckAt = options["wakeCheckAt"]
      guard rawWakeCheckAt == nil || rawWakeCheckAt is NSNull || rawWakeCheckAt is String else {
        throw EngineError(.invalidSpec, "options.wakeCheckAt must be an ISO-8601 string").exception
      }
      let wakeCheckAt = rawWakeCheckAt as? String
      let wakeCheck = try await bridged {
        try await AlarmEngineCore.shared.dismiss(scheduleId, missionCompleted: missionCompleted, wakeCheckAt: wakeCheckAt)
      }
      if let wakeCheck {
        return ["wakeCheck": wakeCheck.wire]
      }
      return [:]
    }

    AsyncFunction("drainObservedEvents") { () async throws -> [[String: Any]] in
      try await bridged { try await AlarmEngineCore.shared.drainObservedEvents() }.map { $0.wire }
    }

    AsyncFunction("ackObservedEvents") { (ids: [String]) async throws in
      try await bridged { try await AlarmEngineCore.shared.ackObservedEvents(ids) }
    }
  }
}

private func parseSpec(_ wire: [String: Any]) throws -> AlarmSpec {
  do {
    return try AlarmSpec(wire: wire)
  } catch {
    throw EngineError.wrap(error).exception
  }
}

/// Maps engine errors to coded Expo exceptions so JS sees e.g. `code: "SNOOZE_LIMIT"`.
private func bridged<T>(_ body: () async throws -> T) async throws -> T {
  do {
    return try await body()
  } catch {
    throw EngineError.wrap(error).exception
  }
}
