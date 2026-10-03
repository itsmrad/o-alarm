package com.oalarm.alarmengine

import android.content.Context
import android.net.Uri
import java.io.File

/**
 * Custom alarm sounds (`sound.kind == "custom"`). The config plugin copies
 * `assets/sounds/<id>.<ext>` into `res/raw/<resourceName(id)>`; ids may also be a file path
 * or a URI. Anything unresolvable rings with the default alarm sound and shows a readiness
 * warning — never silence.
 */
object CustomSounds {
  /** `res/raw` name for an id. Must match `androidSoundResourceName` in plugin/withAlarmEngine.js. */
  fun resourceName(id: String): String {
    val dot = id.lastIndexOf('.')
    val base = (if (dot > 0) id.substring(0, dot) else id).lowercase().replace(Regex("[^a-z0-9_]"), "_")
    return if (base.firstOrNull() in 'a'..'z') base else "s_$base"
  }

  fun uri(context: Context, id: String): Uri? {
    val res = context.resources.getIdentifier(resourceName(id), "raw", context.packageName)
    if (res != 0) return Uri.parse("android.resource://${context.packageName}/$res")
    if (id.startsWith("/")) return File(id).takeIf { it.exists() }?.let { Uri.fromFile(it) }
    return if (id.contains("://")) Uri.parse(id) else null
  }

  /** Custom sound ids among `specs` that can't be resolved (they'd ring with the default sound). */
  fun missing(context: Context, specs: Collection<AlarmSpec>): List<String> =
    specs.mapNotNull { spec -> spec.sound.id?.takeIf { spec.sound.kind == "custom" } }
      .distinct()
      .filter { uri(context, it) == null }
      .sorted()
}
