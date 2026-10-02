import ExpoModulesCore

/// Native alarm engine (AlarmKit, D4). Stub: every call rejects with
/// NOT_IMPLEMENTED until the native engine task lands. Never fakes success.
public class AlarmEngineModule: Module {
  public func definition() -> ModuleDefinition {
    Name("AlarmEngine")

    Events("onTrigger", "onSnooze", "onDismiss", "onStop")

    AsyncFunction("schedule") { (_: [String: Any], promise: Promise) in
      rejectNotImplemented(promise, "schedule")
    }

    AsyncFunction("cancel") { (_: String, promise: Promise) in
      rejectNotImplemented(promise, "cancel")
    }

    AsyncFunction("cancelAll") { (promise: Promise) in
      rejectNotImplemented(promise, "cancelAll")
    }

    AsyncFunction("getScheduled") { (promise: Promise) in
      rejectNotImplemented(promise, "getScheduled")
    }

    AsyncFunction("getReadiness") { (promise: Promise) in
      rejectNotImplemented(promise, "getReadiness")
    }

    AsyncFunction("requestPermission") { (_: String, promise: Promise) in
      rejectNotImplemented(promise, "requestPermission")
    }

    AsyncFunction("previewAlarm") { (_: [String: Any], promise: Promise) in
      rejectNotImplemented(promise, "previewAlarm")
    }
  }
}

private func rejectNotImplemented(_ promise: Promise, _ function: String) {
  promise.reject(
    "NOT_IMPLEMENTED",
    "AlarmEngine.\(function) is not implemented yet: the native AlarmKit engine is not built into this binary"
  )
}
