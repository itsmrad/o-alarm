package com.oalarm.alarmengine

import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Native alarm engine (AlarmManager.setAlarmClock, D5). Stub: every call rejects with
 * NOT_IMPLEMENTED until the native engine task lands. Never fakes success.
 */
class AlarmEngineModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("AlarmEngine")

    Events("onTrigger", "onSnooze", "onDismiss", "onStop")

    AsyncFunction("schedule") { _: Map<String, Any?>, promise: Promise ->
      promise.reject(NotImplementedException("schedule"))
    }

    AsyncFunction("cancel") { _: String, promise: Promise ->
      promise.reject(NotImplementedException("cancel"))
    }

    AsyncFunction("cancelAll") { promise: Promise ->
      promise.reject(NotImplementedException("cancelAll"))
    }

    AsyncFunction("getScheduled") { promise: Promise ->
      promise.reject(NotImplementedException("getScheduled"))
    }

    AsyncFunction("getReadiness") { promise: Promise ->
      promise.reject(NotImplementedException("getReadiness"))
    }

    AsyncFunction("requestPermission") { _: String, promise: Promise ->
      promise.reject(NotImplementedException("requestPermission"))
    }

    AsyncFunction("previewAlarm") { _: Map<String, Any?>, promise: Promise ->
      promise.reject(NotImplementedException("previewAlarm"))
    }
  }
}

class NotImplementedException(function: String) :
  CodedException(
    "NOT_IMPLEMENTED",
    "AlarmEngine.$function is not implemented yet: the native AlarmManager engine is not built into this binary",
    null
  )
