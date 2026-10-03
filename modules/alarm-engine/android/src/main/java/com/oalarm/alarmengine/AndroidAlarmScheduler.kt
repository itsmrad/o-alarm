package com.oalarm.alarmengine

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build

/**
 * D5: `AlarmManager.setAlarmClock` — exact, Doze-exempt, shows the system alarm icon and
 * lets the fire receiver start the foreground ringing service from the background.
 * One PendingIntent per schedule id, distinguished by its data URI (no hash collisions).
 */
class AndroidAlarmScheduler(private val context: Context) : OsAlarmScheduler {
  private val alarmManager = context.getSystemService(AlarmManager::class.java)

  override fun canScheduleExact(): Boolean =
    Build.VERSION.SDK_INT < Build.VERSION_CODES.S || alarmManager.canScheduleExactAlarms()

  override fun arm(spec: AlarmSpec) {
    val info = AlarmManager.AlarmClockInfo(spec.fireInstant.toEpochMilli(), showIntent(spec))
    alarmManager.setAlarmClock(info, firePendingIntent(spec.id, create = true)!!)
  }

  override fun cancel(id: String) {
    firePendingIntent(id, create = false)?.let {
      alarmManager.cancel(it)
      it.cancel()
    }
  }

  override fun isArmed(id: String): Boolean = firePendingIntent(id, create = false) != null

  private fun firePendingIntent(id: String, create: Boolean): PendingIntent? {
    val intent = Intent(context, AlarmFireReceiver::class.java)
      .setAction(AlarmFireReceiver.ACTION_FIRE)
      .setData(scheduleUri(id))
      .putExtra(AlarmFireReceiver.EXTRA_SCHEDULE_ID, id)
    val flags = PendingIntent.FLAG_IMMUTABLE or
      if (create) PendingIntent.FLAG_UPDATE_CURRENT else PendingIntent.FLAG_NO_CREATE
    return PendingIntent.getBroadcast(context, 0, intent, flags)
  }

  /** Tapping the status-bar alarm icon / next-alarm UI opens the app. */
  private fun showIntent(spec: AlarmSpec): PendingIntent? {
    val launch = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return null
    return PendingIntent.getActivity(
      context,
      0,
      launch.setData(scheduleUri(spec.id)),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
  }

  companion object {
    fun scheduleUri(id: String): Uri = Uri.Builder().scheme("oalarm-engine").authority("schedule").appendPath(id).build()
  }
}
