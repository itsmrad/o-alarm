package com.oalarm.alarmengine

import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.media.AudioManager
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import java.time.Instant

/**
 * Honest Android readiness (PRODUCT: Reliability). `blocking` means alarms will not ring;
 * `warning` means they ring but something (UI over the lock screen, OEM killers) may fail.
 */
object Readiness {
  fun status(context: Context, kind: String): String = when (kind) {
    "notifications" ->
      if (context.getSystemService(NotificationManager::class.java).areNotificationsEnabled()) "granted" else "denied"
    "exact_alarm" -> if (AndroidAlarmScheduler(context).canScheduleExact()) "granted" else "denied"
    "full_screen_intent" ->
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE ||
        context.getSystemService(NotificationManager::class.java).canUseFullScreenIntent()
      ) "granted" else "denied"
    "battery_optimization" ->
      if (context.getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(context.packageName)) "granted" else "denied"
    else -> "unavailable" // `alarms` is AlarmKit (iOS) only.
  }

  fun readiness(context: Context): Map<String, Any?> {
    val items = mutableListOf<Map<String, Any?>>()
    items += item("engine", "ok", "Android alarm engine", "Alarms are scheduled with AlarmManager.setAlarmClock and ring through the alarm stream.", null)

    items += if (status(context, "exact_alarm") == "granted") {
      item("exact_alarm", "ok", "Alarms & reminders allowed", "Alarms fire at the exact minute, even in battery saver.", null)
    } else {
      item(
        "exact_alarm", "blocking", "Allow Alarms & reminders",
        "Without this permission Android will not ring alarms on time. Turn on Alarms & reminders for O-Alarm.",
        requestAction("exact_alarm"),
      )
    }

    items += if (status(context, "notifications") == "granted") {
      item("notifications", "ok", "Notifications allowed", "The ringing alarm can show its screen and controls.", null)
    } else {
      item(
        "notifications", "warning", "Allow notifications",
        "Alarms still sound, but the ringing screen and its controls can't appear over the lock screen. You'd have to unlock and open O-Alarm to stop it.",
        requestAction("notifications"),
      )
    }

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      items += if (status(context, "full_screen_intent") == "granted") {
        item("full_screen_intent", "ok", "Full-screen alarms allowed", "The ringing screen opens over the lock screen.", null)
      } else {
        item(
          "full_screen_intent", "warning", "Allow full-screen alarms",
          "Alarms still sound, but only as a notification: the ringing screen won't open over the lock screen.",
          requestAction("full_screen_intent"),
        )
      }
    }

    items += if (status(context, "battery_optimization") == "granted") {
      item("battery_optimization", "ok", "Battery optimization off", "Android won't restrict O-Alarm in the background.", null)
    } else {
      item(
        "battery_optimization", "warning", "Turn off battery optimization",
        "Exact alarms still fire, but some devices delay or kill restricted apps. Set O-Alarm to Unrestricted for the most reliable ringing.",
        requestAction("battery_optimization"),
      )
    }

    val audio = context.getSystemService(AudioManager::class.java)
    if (audio.getStreamVolume(AudioManager.STREAM_ALARM) == 0) {
      items += item(
        "platform_limitation", "warning", "Alarm volume is off",
        "Your alarm volume is at 0, so alarms will vibrate but make no sound. Turn up the alarm volume.",
        null,
      )
    }

    oemHint()?.let { (brand, detail) ->
      items += item("platform_limitation", "warning", "$brand may stop alarms", detail, mapOf("type" to "open_settings"))
    }

    items += item(
      "platform_limitation", "ok", "Force stop cancels alarms",
      "If you force stop O-Alarm in Settings, Android cancels its alarms until you open the app again.",
      null,
    )

    return mapOf(
      "engine" to "native",
      "canRing" to items.none { it["status"] == "blocking" },
      "checkedAt" to isoString(Instant.now()),
      "items" to items,
    )
  }

  /** Opens the settings screen for `kind` (exact alarm, full-screen intent, battery). */
  fun settingsIntent(context: Context, kind: String): Intent? {
    val pkg = Uri.parse("package:${context.packageName}")
    return when (kind) {
      "exact_alarm" -> if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, pkg)
      } else null
      "full_screen_intent" -> if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
        Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, pkg)
      } else null
      "battery_optimization" -> Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
      "notifications" -> Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
        .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
      else -> null
    }
  }

  private fun requestAction(permission: String) = mapOf("type" to "request_permission", "permission" to permission)

  private fun item(kind: String, status: String, title: String, detail: String, action: Map<String, Any?>?) =
    mapOf("kind" to kind, "status" to status, "title" to title, "detail" to detail, "action" to action)

  private fun oemHint(): Pair<String, String>? {
    val maker = Build.MANUFACTURER.lowercase()
    val brand = when {
      maker.contains("xiaomi") || maker.contains("redmi") || maker.contains("poco") -> "Xiaomi"
      maker.contains("huawei") || maker.contains("honor") -> "Huawei"
      maker.contains("samsung") -> "Samsung"
      maker.contains("oneplus") -> "OnePlus"
      maker.contains("oppo") || maker.contains("realme") -> "Oppo"
      maker.contains("vivo") -> "Vivo"
      maker.contains("meizu") -> "Meizu"
      maker.contains("asus") -> "Asus"
      else -> return null
    }
    return brand to "$brand devices can stop background apps on their own. In App info, allow autostart / " +
      "background activity and set battery to Unrestricted (see dontkillmyapp.com for your model)."
  }
}
