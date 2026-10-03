package com.oalarm.alarmengine

import android.Manifest
import android.content.Context
import android.content.Intent
import android.os.Build
import expo.modules.interfaces.permissions.PermissionsStatus
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Native alarm engine (AlarmManager.setAlarmClock, D5) behind the AlarmEngine contract.
 * All logic lives in [AlarmEngineCore]; this bridges JS and maps every failure to a typed
 * AlarmEngineErrorCode (nothing fails silently).
 */
class AlarmEngineModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  private val engine: AlarmEngineCore
    get() = Engine.get(context)

  override fun definition() = ModuleDefinition {
    Name("AlarmEngine")

    Events("onTrigger", "onSnooze", "onDismiss", "onStop")

    OnCreate {
      val core = engine
      core.sink = EngineEventSink { name, payload -> sendEvent(name, payload) }
      // Self-heal on every app start: re-arm the mirror, resume an interrupted ring.
      Thread { runCatching { core.restore(RestoreReason.APP_START) } }.start()
    }

    OnDestroy {
      appContext.reactContext?.let { Engine.get(it).sink = null }
    }

    AsyncFunction("schedule") { spec: Map<String, Any?> ->
      guarded { engine.schedule(AlarmSpec.fromMap(spec)).toMap() }
    }

    AsyncFunction("cancel") { id: String ->
      guarded { engine.cancel(id) }
    }

    AsyncFunction("cancelAll") {
      guarded { engine.cancelAll() }
    }

    AsyncFunction("getScheduled") {
      guarded { engine.getScheduled().map { it.toMap() } }
    }

    AsyncFunction("getReadiness") {
      guarded { Readiness.readiness(context) }
    }

    AsyncFunction("requestPermission") { kind: String, promise: Promise ->
      try {
        requestPermission(kind, promise)
      } catch (e: Exception) {
        promise.reject(toCoded(e))
      }
    }

    AsyncFunction("previewAlarm") { spec: Map<String, Any?> ->
      guarded { engine.preview(AlarmSpec.fromMap(spec)) }
    }

    AsyncFunction("getActiveRinging") {
      guarded { engine.getRinging()?.toMap() }
    }

    AsyncFunction("snooze") { scheduleId: String ->
      guarded { engine.snooze(scheduleId).toMap() }
    }

    AsyncFunction("dismiss") { scheduleId: String, options: Map<String, Any?> ->
      guarded {
        val missionCompleted = options["missionCompleted"] as? Boolean
          ?: throw EngineException(EngineException.INVALID_SPEC, "missionCompleted must be a boolean")
        val wakeCheckAt = options["wakeCheckAt"]?.let {
          it as? String ?: throw EngineException(EngineException.INVALID_SPEC, "wakeCheckAt must be an ISO string")
        }
        val wakeCheck = engine.dismiss(scheduleId, missionCompleted, wakeCheckAt)
        if (wakeCheck == null) emptyMap() else mapOf("wakeCheck" to wakeCheck.toMap())
      }
    }

    AsyncFunction("drainObservedEvents") {
      guarded { engine.drainEvents().map { it.toMap() } }
    }

    AsyncFunction("ackObservedEvents") { ids: List<String> ->
      guarded { engine.ackEvents(ids) }
    }
  }

  private fun requestPermission(kind: String, promise: Promise) {
    val current = Readiness.status(context, kind)
    if (current == "granted" || current == "unavailable") {
      promise.resolve(current)
      return
    }
    if (kind == "notifications" && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      val permissions = appContext.permissions
      if (permissions != null) {
        permissions.askForPermissions(
          { result ->
            val response = result[Manifest.permission.POST_NOTIFICATIONS]
            when {
              response?.status == PermissionsStatus.GRANTED -> promise.resolve("granted")
              // Permanently denied: the only way left is the notification settings screen.
              response?.canAskAgain == false -> {
                openSettings(kind)
                promise.resolve("denied")
              }
              else -> promise.resolve("denied")
            }
          },
          Manifest.permission.POST_NOTIFICATIONS,
        )
        return
      }
    }
    // Special-access permissions are granted on a Settings screen; JS re-checks readiness
    // when the app returns to the foreground.
    openSettings(kind)
    promise.resolve(current)
  }

  private fun openSettings(kind: String) {
    val intent = Readiness.settingsIntent(context, kind) ?: return
    val activity = appContext.currentActivity
    if (activity != null) {
      activity.startActivity(intent)
    } else {
      context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
  }

  private inline fun <T> guarded(block: () -> T): T =
    try {
      block()
    } catch (e: Exception) {
      throw toCoded(e)
    }

  private fun toCoded(e: Exception): CodedException = when (e) {
    is CodedException -> e
    is EngineException -> CodedException(e.code, e.message, e)
    is SecurityException -> CodedException(EngineException.PERMISSION_DENIED, e.message, e)
    else -> CodedException(EngineException.UNKNOWN, e.message ?: e.javaClass.simpleName, e)
  }
}
