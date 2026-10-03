package com.oalarm.alarmengine

import android.app.Activity
import android.content.Context
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import expo.modules.core.interfaces.Package
import expo.modules.core.interfaces.ReactActivityLifecycleListener
import java.lang.ref.WeakReference

/** Registers [RingingActivityLifecycle] with the RN activity (Expo autolinking). */
class AlarmEnginePackage : Package {
  override fun createReactActivityLifecycleListeners(activityContext: Context): List<ReactActivityLifecycleListener> =
    listOf(RingingActivityLifecycle)
}

/**
 * Shows the RN activity over the lock screen and turns the screen on only while an alarm
 * rings, so the full-screen intent can present /ringing without making the whole app
 * reachable from the lock screen the rest of the time.
 */
object RingingActivityLifecycle : ReactActivityLifecycleListener {
  const val EXTRA_RINGING = "com.oalarm.alarmengine.RINGING"

  @Volatile private var activity: WeakReference<Activity>? = null

  override fun onCreate(activity: Activity, savedInstanceState: Bundle?) = update(activity)

  override fun onResume(activity: Activity) = update(activity)

  override fun onDestroy(activity: Activity) {
    if (this.activity?.get() === activity) this.activity = null
  }

  /** Called when ringing ends (service stopped). */
  fun ringingEnded() {
    activity?.get()?.let { act -> act.runOnUiThread { setLockScreenFlags(act, false) } }
  }

  private fun update(activity: Activity) {
    this.activity = WeakReference(activity)
    val ringing = Engine.get(activity).getRinging() != null
    setLockScreenFlags(activity, ringing)
  }

  private fun setLockScreenFlags(activity: Activity, ringing: Boolean) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
      activity.setShowWhenLocked(ringing)
      activity.setTurnScreenOn(ringing)
    } else {
      @Suppress("DEPRECATION")
      val flags = WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
      if (ringing) activity.window.addFlags(flags) else activity.window.clearFlags(flags)
    }
  }
}
