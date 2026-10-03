package com.oalarm.alarmengine

import android.app.AlarmManager
import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import java.util.TimeZone

private const val TAG = "AlarmEngine"

/** An exact alarm fired: start ringing (the setAlarmClock exemption allows the FGS start). */
class AlarmFireReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != ACTION_FIRE) return
    val id = intent.getStringExtra(EXTRA_SCHEDULE_ID) ?: return
    try {
      Engine.get(context).onFire(id)
    } catch (e: Exception) {
      Log.e(TAG, "fire $id failed", e)
    }
  }

  companion object {
    const val ACTION_FIRE = "com.oalarm.alarmengine.FIRE"
    const val EXTRA_SCHEDULE_ID = "scheduleId"
  }
}

/**
 * Restores the native mirror without JS (D5, D10): boot (incl. before first unlock),
 * clock / time-zone changes, app upgrade and exact-alarm permission re-grant.
 */
class SystemEventReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val reason = when (intent.action) {
      Intent.ACTION_LOCKED_BOOT_COMPLETED -> RestoreReason.LOCKED_BOOT
      Intent.ACTION_BOOT_COMPLETED -> RestoreReason.BOOT
      Intent.ACTION_MY_PACKAGE_REPLACED -> RestoreReason.PACKAGE_REPLACED
      Intent.ACTION_TIME_CHANGED -> RestoreReason.TIME_SET
      Intent.ACTION_TIMEZONE_CHANGED -> RestoreReason.TIMEZONE_CHANGED
      AlarmManager.ACTION_SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED -> RestoreReason.EXACT_ALARM_PERMISSION
      else -> return
    }
    // The cached default zone can lag the broadcast; force a re-read before recomputing.
    if (reason == RestoreReason.TIMEZONE_CHANGED) TimeZone.setDefault(null)
    try {
      Engine.get(context).restore(reason)
    } catch (e: Exception) {
      Log.e(TAG, "restore ${reason.name} failed", e)
    }
  }
}

/** Notification actions on the ringing notification; work with JS dead. */
class RingingActionReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val engine = Engine.get(context)
    val id = intent.getStringExtra(AlarmFireReceiver.EXTRA_SCHEDULE_ID)
    try {
      when (intent.action) {
        ACTION_SNOOZE -> id?.let { engine.snooze(it) }
        ACTION_DISMISS -> id?.let { engine.dismiss(it, missionCompleted = false, wakeCheckAt = null) }
        // The user swiped the ongoing notification away (allowed on Android 14+): repost it.
        ACTION_REPOST -> engine.getRinging()?.let { ringing ->
          context.getSystemService(NotificationManager::class.java)
            .notify(RingingService.NOTIFICATION_ID, RingingService.buildNotification(context, ringing))
        }
      }
    } catch (e: EngineException) {
      Log.w(TAG, "ringing action ${intent.action} rejected: ${e.code} ${e.message}")
    }
  }

  companion object {
    const val ACTION_SNOOZE = "com.oalarm.alarmengine.SNOOZE"
    const val ACTION_DISMISS = "com.oalarm.alarmengine.DISMISS"
    const val ACTION_REPOST = "com.oalarm.alarmengine.REPOST"
  }
}
