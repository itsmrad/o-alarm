package com.oalarm.alarmengine

import android.content.Context
import java.io.File

/**
 * Process-wide engine shared by the Expo module, receivers and the ringing service.
 * State lives in device-protected storage (direct-boot aware, never backed up), so
 * LOCKED_BOOT_COMPLETED can restore alarms before the user unlocks.
 */
object Engine {
  @Volatile private var core: AlarmEngineCore? = null

  fun get(context: Context): AlarmEngineCore =
    core ?: synchronized(this) {
      core ?: create(context.applicationContext).also { core = it }
    }

  private fun create(app: Context): AlarmEngineCore {
    val storage = app.createDeviceProtectedStorageContext()
    val file = File(File(storage.noBackupFilesDir, "alarm-engine"), "state.json")
    return AlarmEngineCore(AlarmStore(file), AndroidAlarmScheduler(app), ServiceRinger(app))
  }
}
