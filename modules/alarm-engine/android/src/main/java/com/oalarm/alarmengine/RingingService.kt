package com.oalarm.alarmengine

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaPlayer
import android.media.RingtoneManager
import android.media.ToneGenerator
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.VibrationAttributes
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.util.Log
import java.io.File

/** Starts/stops [RingingService]; the service reads what to ring from the engine. */
class ServiceRinger(private val context: Context) : Ringer {
  override fun ring() {
    try {
      context.startForegroundService(Intent(context, RingingService::class.java))
    } catch (e: Exception) {
      // E.g. ForegroundServiceStartNotAllowedException outside an exemption window.
      Log.e("AlarmEngine", "could not start the ringing service", e)
    }
  }

  override fun stop() {
    context.stopService(Intent(context, RingingService::class.java))
  }
}

/**
 * Foreground ringing (D5): alarm-stream audio (custom / system / default sound, falling back
 * to the default alarm and finally a generated tone, so it is never silent), vibration,
 * gradual volume escalation and a full-screen intent that opens the app on /ringing.
 * It keeps ringing when JS dies; it stops only through the engine (dismiss / snooze).
 */
class RingingService : Service() {
  private val handler = Handler(Looper.getMainLooper())
  private var current: RingingRecord? = null
  private var player: MediaPlayer? = null
  private var tone: ToneGenerator? = null
  private var vibrator: Vibrator? = null
  private var wakeLock: PowerManager.WakeLock? = null
  private var focusRequest: AudioFocusRequest? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val ringing = Engine.get(this).getRinging()
    if (ringing == null) {
      // startForeground is still required after startForegroundService.
      startForegroundCompat(buildIdleNotification(this))
      stopEverything()
      stopSelf()
      return START_NOT_STICKY
    }
    startForegroundCompat(buildNotification(this, ringing))
    if (current?.scheduleId != ringing.scheduleId || current?.firedAt != ringing.firedAt) {
      stopPlayback()
      current = ringing
      startPlayback(ringing)
    }
    // Restarted after process death: the engine still holds the ring, so ring again.
    return START_STICKY
  }

  override fun onDestroy() {
    stopEverything()
    super.onDestroy()
  }

  private fun startForegroundCompat(notification: Notification) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
  }

  private fun startPlayback(ringing: RingingRecord) {
    val spec = ringing.spec
    wakeLock = getSystemService(PowerManager::class.java)
      .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "oalarm:ringing")
      .apply { acquire(WAKE_LOCK_TIMEOUT_MS) }
    requestFocus()
    if (!startPlayer(soundUri(spec.sound)) && !startPlayer(defaultAlarmUri())) startTone()
    // D37: retriggers ring at full volume at once.
    val ramp = spec.kind != ScheduleKinds.RETRIGGER && spec.escalation.enabled && spec.escalation.rampSeconds > 0
    if (ramp) escalate(spec.escalation.rampSeconds) else setVolume(1f)
    if (spec.vibration) startVibration()
  }

  private fun startPlayer(uri: Uri?): Boolean {
    if (uri == null) return false
    return try {
      player = MediaPlayer().apply {
        setAudioAttributes(ALARM_AUDIO)
        setDataSource(this@RingingService, uri)
        isLooping = true
        prepare()
        start()
      }
      true
    } catch (e: Exception) {
      Log.w("AlarmEngine", "sound $uri failed, falling back", e)
      player?.release()
      player = null
      false
    }
  }

  private fun startTone() {
    tone = try {
      ToneGenerator(AudioManager.STREAM_ALARM, ToneGenerator.MAX_VOLUME)
    } catch (e: Exception) {
      null
    }
    val loop = object : Runnable {
      override fun run() {
        tone?.startTone(ToneGenerator.TONE_CDMA_ALERT_CALL_GUARD, 800) ?: return
        handler.postDelayed(this, 1_200)
      }
    }
    handler.post(loop)
  }

  /** Gradual escalation: player volume ramps from 15% to 100% of the alarm stream. */
  private fun escalate(rampSeconds: Int) {
    val start = System.currentTimeMillis()
    val step = object : Runnable {
      override fun run() {
        val progress = ((System.currentTimeMillis() - start) / (rampSeconds * 1000f)).coerceIn(0f, 1f)
        setVolume(0.15f + 0.85f * progress)
        if (progress < 1f) handler.postDelayed(this, 500)
      }
    }
    handler.post(step)
  }

  private fun setVolume(volume: Float) {
    try {
      player?.setVolume(volume, volume)
    } catch (_: IllegalStateException) {
    }
  }

  private fun startVibration() {
    val vib = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      getSystemService(VibratorManager::class.java).defaultVibrator
    } else {
      @Suppress("DEPRECATION")
      getSystemService(Vibrator::class.java)
    }
    if (!vib.hasVibrator()) return
    vibrator = vib
    val effect = VibrationEffect.createWaveform(longArrayOf(0, 800, 600), 0)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      vib.vibrate(effect, VibrationAttributes.createForUsage(VibrationAttributes.USAGE_ALARM))
    } else {
      @Suppress("DEPRECATION")
      vib.vibrate(effect, ALARM_AUDIO)
    }
  }

  private fun requestFocus() {
    val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
      .setAudioAttributes(ALARM_AUDIO)
      .setOnAudioFocusChangeListener { /* an alarm never yields */ }
      .build()
    getSystemService(AudioManager::class.java).requestAudioFocus(request)
    focusRequest = request
  }

  private fun soundUri(sound: AlarmSound): Uri? = when (sound.kind) {
    "custom" -> sound.id?.let { customSoundUri(it) }
    "system" -> sound.id?.let { Uri.parse(it) }
    else -> null
  } ?: defaultAlarmUri()

  /** A custom sound is a bundled raw resource name (with or without extension), a file path or a URI. */
  private fun customSoundUri(id: String): Uri? {
    val name = id.substringBeforeLast('.').lowercase().replace(Regex("[^a-z0-9_]"), "_")
    val res = resources.getIdentifier(name, "raw", packageName)
    if (res != 0) return Uri.parse("android.resource://$packageName/$res")
    if (id.startsWith("/")) return File(id).takeIf { it.exists() }?.let { Uri.fromFile(it) }
    return if (id.contains("://")) Uri.parse(id) else null
  }

  private fun defaultAlarmUri(): Uri? =
    RingtoneManager.getActualDefaultRingtoneUri(this, RingtoneManager.TYPE_ALARM)
      ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)
      ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)

  private fun stopPlayback() {
    handler.removeCallbacksAndMessages(null)
    player?.run {
      try {
        stop()
      } catch (_: IllegalStateException) {
      }
      release()
    }
    player = null
    tone?.release()
    tone = null
    vibrator?.cancel()
    vibrator = null
    focusRequest?.let { getSystemService(AudioManager::class.java).abandonAudioFocusRequest(it) }
    focusRequest = null
    wakeLock?.takeIf { it.isHeld }?.release()
    wakeLock = null
  }

  private fun stopEverything() {
    stopPlayback()
    current = null
    RingingActivityLifecycle.ringingEnded()
  }

  companion object {
    const val NOTIFICATION_ID = 0x0A1A
    private const val CHANNEL_ID = "oalarm_ringing"
    private const val WAKE_LOCK_TIMEOUT_MS = 60 * 60 * 1000L

    /** Kept in sync with app.config.ts `scheme`; Expo Router maps it to app/ringing.tsx. */
    private const val RINGING_URL = "oalarm://ringing"

    val ALARM_AUDIO: AudioAttributes = AudioAttributes.Builder()
      .setUsage(AudioAttributes.USAGE_ALARM)
      .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
      .build()

    private fun ensureChannel(context: Context) {
      val manager = context.getSystemService(NotificationManager::class.java)
      if (manager.getNotificationChannel(CHANNEL_ID) != null) return
      manager.createNotificationChannel(
        NotificationChannel(CHANNEL_ID, "Ringing alarms", NotificationManager.IMPORTANCE_HIGH).apply {
          description = "Shows the ringing alarm. Sound and vibration come from the alarm itself."
          setSound(null, null)
          enableVibration(false)
          setBypassDnd(true)
          lockscreenVisibility = Notification.VISIBILITY_PUBLIC
        },
      )
    }

    /** Opens the RN app on /ringing (deep link handled by Expo Router, also on cold start). */
    fun ringingActivityIntent(context: Context, ringing: RingingRecord): Intent? {
      val launch = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return null
      val url = Uri.parse(RINGING_URL).buildUpon()
        .appendQueryParameter("alarmId", ringing.spec.alarmId)
        .appendQueryParameter("occurrenceKey", ringing.spec.occurrenceKey)
        .appendQueryParameter("scheduleId", ringing.spec.id)
        .build()
      return Intent(Intent.ACTION_VIEW, url).apply {
        component = launch.component
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        putExtra(RingingActivityLifecycle.EXTRA_RINGING, true)
      }
    }

    fun buildNotification(context: Context, ringing: RingingRecord): Notification {
      ensureChannel(context)
      val spec = ringing.spec
      val open = ringingActivityIntent(context, ringing)?.let {
        PendingIntent.getActivity(context, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
      }
      val builder = Notification.Builder(context, CHANNEL_ID)
        .setSmallIcon(R.drawable.oalarm_engine_ic_alarm)
        .setContentTitle(spec.label)
        .setContentText(if (spec.hasMissions) "Open O-Alarm to complete your mission" else "Alarm")
        .setCategory(Notification.CATEGORY_ALARM)
        .setVisibility(Notification.VISIBILITY_PUBLIC)
        .setOngoing(true)
        .setAutoCancel(false)
        .setShowWhen(true)
        .setWhen(java.time.Instant.parse(ringing.firedAt).toEpochMilli())
        .setDeleteIntent(actionIntent(context, RingingActionReceiver.ACTION_REPOST, spec.id))
      if (open != null) {
        builder.setContentIntent(open).setFullScreenIntent(open, true)
      }
      // System-UI actions only where they can't bypass a mission or Wake Check (D13/D14).
      val snoozable = spec.kind != ScheduleKinds.WAKE_CHECK && spec.snooze.enabled && ringing.snoozeCount < spec.snooze.maxCount
      if (!spec.hasMissions && snoozable) {
        builder.addAction(action(context, "Snooze", RingingActionReceiver.ACTION_SNOOZE, spec.id))
      }
      if (!spec.hasMissions && !spec.wakeCheck) {
        builder.addAction(action(context, "Dismiss", RingingActionReceiver.ACTION_DISMISS, spec.id))
      }
      return builder.build()
    }

    private fun buildIdleNotification(context: Context): Notification {
      ensureChannel(context)
      return Notification.Builder(context, CHANNEL_ID)
        .setSmallIcon(R.drawable.oalarm_engine_ic_alarm)
        .setContentTitle("O-Alarm")
        .build()
    }

    private fun actionIntent(context: Context, action: String, scheduleId: String): PendingIntent {
      val intent = Intent(context, RingingActionReceiver::class.java)
        .setAction(action)
        .setData(AndroidAlarmScheduler.scheduleUri(scheduleId))
        .putExtra(AlarmFireReceiver.EXTRA_SCHEDULE_ID, scheduleId)
      return PendingIntent.getBroadcast(context, 0, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    private fun action(context: Context, title: String, action: String, scheduleId: String): Notification.Action =
      Notification.Action.Builder(null, title, actionIntent(context, action, scheduleId)).build()
  }
}
