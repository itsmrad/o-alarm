package com.oalarm.alarmengine

import android.app.Application
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.UserManager
import android.util.Log

/**
 * Direct boot (D5): `LOCKED_BOOT_COMPLETED` starts the app process before the first unlock,
 * which runs `Application.onCreate`. React Native (SoLoader) and Expo modules (e.g. the dev
 * launcher's SharedPreferences) touch credential-encrypted storage, which throws while the
 * user is locked — the crash would also kill the alarm restore. The config plugin makes the
 * generated `MainApplication.onCreate` call [deferUntilUnlocked] first: while locked it skips
 * that init (the engine itself only uses device-protected storage) and runs it on
 * `ACTION_USER_UNLOCKED`, which is delivered to registered receivers only.
 */
object DirectBoot {
  /** True when the app init was deferred; `init` then runs once, on unlock. */
  fun deferUntilUnlocked(app: Application, init: () -> Unit): Boolean =
    deferUntilUnlocked(
      isUnlocked = { app.getSystemService(UserManager::class.java).isUserUnlocked },
      register = { onUnlock -> registerUnlock(app, onUnlock) },
      init = init,
    ).also { deferred ->
      if (deferred) Log.i("AlarmEngine", "direct boot: app init deferred until the user unlocks")
    }

  /** Platform-free core of [deferUntilUnlocked]; `register` returns its unregister call. */
  fun deferUntilUnlocked(
    isUnlocked: () -> Boolean,
    register: (onUnlock: () -> Unit) -> () -> Unit,
    init: () -> Unit,
  ): Boolean {
    if (isUnlocked()) return false
    var done = false
    var unregister: (() -> Unit)? = null
    unregister = register {
      if (!done) {
        done = true
        unregister?.invoke()
        init()
      }
    }
    // Unlocked between the check and the registration: the broadcast may be gone already.
    if (!done && isUnlocked()) {
      done = true
      unregister()
      return false
    }
    return true
  }

  private fun registerUnlock(app: Application, onUnlock: () -> Unit): () -> Unit {
    val receiver = object : BroadcastReceiver() {
      override fun onReceive(context: Context, intent: Intent) = onUnlock()
    }
    val filter = IntentFilter(Intent.ACTION_USER_UNLOCKED)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      app.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
    } else {
      app.registerReceiver(receiver, filter)
    }
    return { app.unregisterReceiver(receiver) }
  }
}
