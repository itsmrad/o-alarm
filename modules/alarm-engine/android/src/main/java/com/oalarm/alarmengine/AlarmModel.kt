package com.oalarm.alarmengine

import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeParseException

/** Typed engine failure; `code` is an AlarmEngineErrorCode (src/engine/types.ts). */
class EngineException(val code: String, message: String, cause: Throwable? = null) :
  Exception(message, cause) {
  companion object {
    const val PERMISSION_DENIED = "PERMISSION_DENIED"
    const val INVALID_SPEC = "INVALID_SPEC"
    const val SCHEDULE_FAILED = "SCHEDULE_FAILED"
    const val SNOOZE_LIMIT = "SNOOZE_LIMIT"
    const val NOT_RINGING = "NOT_RINGING"
    const val UNKNOWN = "UNKNOWN"
  }
}

private fun invalid(message: String): Nothing = throw EngineException(EngineException.INVALID_SPEC, message)

private val ISO_MILLIS: DateTimeFormatter =
  DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC)

/** Same shape as JS `Date#toISOString()`. */
fun isoString(instant: Instant): String = ISO_MILLIS.format(instant)

fun parseInstant(value: String, field: String): Instant =
  try {
    Instant.parse(value)
  } catch (e: DateTimeParseException) {
    invalid("$field is not an ISO-8601 instant: $value")
  }

object ScheduleKinds {
  const val ALARM = "alarm"
  const val SNOOZE = "snooze"
  const val WAKE_CHECK = "wake_check"
  const val RETRIGGER = "retrigger"
  val ALL = setOf(ALARM, SNOOZE, WAKE_CHECK, RETRIGGER)
}

/** D28 wall-clock rule of an `alarm` occurrence. */
data class WallClock(
  val hour: Int,
  val minute: Int,
  val localDate: String,
  /** IANA zone, or null = floating (device zone). */
  val timeZone: String?,
  /** 0 = Sunday … 6 = Saturday; empty = one-time. */
  val weekdays: List<Int>,
) {
  val date: LocalDate get() = LocalDate.parse(localDate)

  fun zone(device: ZoneId): ZoneId = timeZone?.let { ZoneId.of(it) } ?: device
}

data class AlarmSound(val kind: String, val id: String?)

data class Escalation(val enabled: Boolean, val rampSeconds: Int)

data class SnoozeConfig(val enabled: Boolean, val durationMin: Int, val maxCount: Int)

/** Mirror of the TS `AlarmScheduleSpec`, stored verbatim (D10). */
data class AlarmSpec(
  val id: String,
  val alarmId: String,
  val occurrenceKey: String,
  val kind: String,
  val fireAt: String,
  val wallClock: WallClock?,
  val label: String,
  val sound: AlarmSound,
  val vibration: Boolean,
  val escalation: Escalation,
  val snooze: SnoozeConfig,
  val hasMissions: Boolean,
  val wakeCheck: Boolean,
  val important: Boolean,
) {
  val fireInstant: Instant get() = Instant.parse(fireAt)

  fun validate() {
    if (id.isBlank()) invalid("id is empty")
    if (alarmId.isBlank()) invalid("alarmId is empty")
    if (occurrenceKey.isBlank()) invalid("occurrenceKey is empty")
    if (kind !in ScheduleKinds.ALL) invalid("unknown kind: $kind")
    parseInstant(fireAt, "fireAt")
    if (sound.kind !in setOf("default", "system", "custom")) invalid("unknown sound kind: ${sound.kind}")
    if (sound.kind == "custom" && sound.id.isNullOrBlank()) invalid("custom sound needs an id")
    if (escalation.rampSeconds < 0) invalid("escalation.rampSeconds must be >= 0")
    if (snooze.durationMin < 1 && snooze.enabled) invalid("snooze.durationMin must be >= 1")
    if (snooze.maxCount < 0) invalid("snooze.maxCount must be >= 0")
    wallClock?.let { wc ->
      if (wc.hour !in 0..23 || wc.minute !in 0..59) invalid("wallClock time out of range")
      try {
        wc.date
      } catch (e: DateTimeParseException) {
        invalid("wallClock.localDate is not YYYY-MM-DD: ${wc.localDate}")
      }
      if (wc.weekdays.any { it !in 0..6 }) invalid("wallClock.weekdays must be 0..6")
      wc.timeZone?.let {
        try {
          ZoneId.of(it)
        } catch (e: Exception) {
          invalid("unknown time zone: $it")
        }
      }
    }
  }

  fun toJson(): JSONObject = JSONObject().apply {
    put("id", id)
    put("alarmId", alarmId)
    put("occurrenceKey", occurrenceKey)
    put("kind", kind)
    put("fireAt", fireAt)
    wallClock?.let { wc ->
      put(
        "wallClock",
        JSONObject().apply {
          put("hour", wc.hour)
          put("minute", wc.minute)
          put("localDate", wc.localDate)
          put("timeZone", wc.timeZone ?: JSONObject.NULL)
          put("weekdays", JSONArray(wc.weekdays))
        },
      )
    }
    put("label", label)
    put("sound", JSONObject().apply { put("kind", sound.kind); put("id", sound.id ?: JSONObject.NULL) })
    put("vibration", vibration)
    put("escalation", JSONObject().apply { put("enabled", escalation.enabled); put("rampSeconds", escalation.rampSeconds) })
    put(
      "snooze",
      JSONObject().apply {
        put("enabled", snooze.enabled)
        put("durationMin", snooze.durationMin)
        put("maxCount", snooze.maxCount)
      },
    )
    put("hasMissions", hasMissions)
    put("wakeCheck", wakeCheck)
    put("important", important)
  }

  fun toMap(): MutableMap<String, Any?> = mutableMapOf<String, Any?>(
    "id" to id,
    "alarmId" to alarmId,
    "occurrenceKey" to occurrenceKey,
    "kind" to kind,
    "fireAt" to fireAt,
    "label" to label,
    "sound" to mapOf("kind" to sound.kind, "id" to sound.id),
    "vibration" to vibration,
    "escalation" to mapOf("enabled" to escalation.enabled, "rampSeconds" to escalation.rampSeconds),
    "snooze" to mapOf(
      "enabled" to snooze.enabled,
      "durationMin" to snooze.durationMin,
      "maxCount" to snooze.maxCount,
    ),
    "hasMissions" to hasMissions,
    "wakeCheck" to wakeCheck,
    "important" to important,
  ).apply {
    wallClock?.let { wc ->
      put(
        "wallClock",
        mapOf(
          "hour" to wc.hour,
          "minute" to wc.minute,
          "localDate" to wc.localDate,
          "timeZone" to wc.timeZone,
          "weekdays" to wc.weekdays,
        ),
      )
    }
  }

  companion object {
    fun fromJson(o: JSONObject): AlarmSpec = AlarmSpec(
      id = o.getString("id"),
      alarmId = o.getString("alarmId"),
      occurrenceKey = o.getString("occurrenceKey"),
      kind = o.getString("kind"),
      fireAt = o.getString("fireAt"),
      wallClock = o.optJSONObject("wallClock")?.let { wc ->
        val days = wc.getJSONArray("weekdays")
        WallClock(
          hour = wc.getInt("hour"),
          minute = wc.getInt("minute"),
          localDate = wc.getString("localDate"),
          timeZone = if (wc.isNull("timeZone")) null else wc.getString("timeZone"),
          weekdays = (0 until days.length()).map { days.getInt(it) },
        )
      },
      label = o.getString("label"),
      sound = o.getJSONObject("sound").let {
        AlarmSound(it.getString("kind"), if (it.isNull("id")) null else it.getString("id"))
      },
      vibration = o.getBoolean("vibration"),
      escalation = o.getJSONObject("escalation").let { Escalation(it.getBoolean("enabled"), it.getInt("rampSeconds")) },
      snooze = o.getJSONObject("snooze").let {
        SnoozeConfig(it.getBoolean("enabled"), it.getInt("durationMin"), it.getInt("maxCount"))
      },
      hasMissions = o.getBoolean("hasMissions"),
      wakeCheck = o.getBoolean("wakeCheck"),
      important = o.getBoolean("important"),
    )

    /** Parses the JS bridge map. Wrong shapes reject with INVALID_SPEC, never crash. */
    fun fromMap(m: Map<String, Any?>): AlarmSpec {
      fun str(map: Map<*, *>, key: String): String = map[key] as? String ?: invalid("$key must be a string")
      fun optStr(map: Map<*, *>, key: String): String? = map[key]?.let { it as? String ?: invalid("$key must be a string or null") }
      fun int(map: Map<*, *>, key: String): Int {
        val n = map[key] as? Number ?: invalid("$key must be a number")
        val d = n.toDouble()
        if (d.isNaN() || d.isInfinite() || d != Math.floor(d)) invalid("$key must be an integer")
        return d.toInt()
      }
      fun bool(map: Map<*, *>, key: String): Boolean = map[key] as? Boolean ?: invalid("$key must be a boolean")
      fun obj(map: Map<*, *>, key: String): Map<*, *> = map[key] as? Map<*, *> ?: invalid("$key must be an object")

      val wallClock = (m["wallClock"] as? Map<*, *>)?.let { wc ->
        val days = wc["weekdays"] as? List<*> ?: invalid("wallClock.weekdays must be an array")
        WallClock(
          hour = int(wc, "hour"),
          minute = int(wc, "minute"),
          localDate = str(wc, "localDate"),
          timeZone = optStr(wc, "timeZone"),
          weekdays = days.map { (it as? Number)?.toInt() ?: invalid("wallClock.weekdays must be numbers") },
        )
      }
      val sound = obj(m, "sound")
      val escalation = obj(m, "escalation")
      val snooze = obj(m, "snooze")
      return AlarmSpec(
        id = str(m, "id"),
        alarmId = str(m, "alarmId"),
        occurrenceKey = str(m, "occurrenceKey"),
        kind = str(m, "kind"),
        fireAt = str(m, "fireAt"),
        wallClock = wallClock,
        label = str(m, "label"),
        sound = AlarmSound(str(sound, "kind"), optStr(sound, "id")),
        vibration = bool(m, "vibration"),
        escalation = Escalation(bool(escalation, "enabled"), int(escalation, "rampSeconds")),
        snooze = SnoozeConfig(bool(snooze, "enabled"), int(snooze, "durationMin"), int(snooze, "maxCount")),
        hasMissions = bool(m, "hasMissions"),
        wakeCheck = bool(m, "wakeCheck"),
        important = bool(m, "important"),
      )
    }
  }
}

/** A mirror entry: the spec plus when it was armed. */
data class ScheduledEntry(val spec: AlarmSpec, val scheduledAt: String) {
  fun toJson(): JSONObject = spec.toJson().put("scheduledAt", scheduledAt)

  fun toMap(): Map<String, Any?> = spec.toMap().apply { put("scheduledAt", scheduledAt) }

  companion object {
    fun fromJson(o: JSONObject) = ScheduledEntry(AlarmSpec.fromJson(o), o.getString("scheduledAt"))
  }
}

/** The ringing alarm, persisted so a cold start / process restart can resume it. */
data class RingingRecord(val spec: AlarmSpec, val firedAt: String, val snoozeCount: Int) {
  val scheduleId: String get() = spec.id

  fun toJson(): JSONObject = JSONObject().apply {
    put("spec", spec.toJson())
    put("firedAt", firedAt)
    put("snoozeCount", snoozeCount)
  }

  /** `RingingState` (AlarmEngine.types.ts). */
  fun toMap(): Map<String, Any?> = mapOf(
    "scheduleId" to spec.id,
    "alarmId" to spec.alarmId,
    "occurrenceKey" to spec.occurrenceKey,
    "kind" to spec.kind,
    "at" to firedAt,
    "firedAt" to firedAt,
    "snoozeCount" to snoozeCount,
    "label" to spec.label,
    "hasMissions" to spec.hasMissions,
    "wakeCheck" to spec.wakeCheck,
    "important" to spec.important,
  )

  companion object {
    fun fromJson(o: JSONObject) =
      RingingRecord(AlarmSpec.fromJson(o.getJSONObject("spec")), o.getString("firedAt"), o.getInt("snoozeCount"))
  }
}

object ObservedTypes {
  const val TRIGGER_RECEIVED = "trigger_received"
  const val SNOOZED = "snoozed"
  const val DISMISSED = "dismissed"
  const val RESTORED_AFTER_BOOT = "schedule_restored_after_boot"
  const val TZ_CHANGE_RESCHEDULED = "tz_change_rescheduled"
  const val MISSED = "missed"
  const val SCHEDULE_FAILED = "schedule_failed"
}

/** `ObservedEngineEvent` (AlarmEngine.types.ts). */
data class ObservedEvent(
  val id: String,
  val type: String,
  val scheduleId: String,
  val alarmId: String,
  val occurrenceKey: String,
  val at: String,
  val detail: String?,
) {
  fun toJson(): JSONObject = JSONObject().apply {
    put("id", id)
    put("type", type)
    put("scheduleId", scheduleId)
    put("alarmId", alarmId)
    put("occurrenceKey", occurrenceKey)
    put("at", at)
    put("detail", detail ?: JSONObject.NULL)
  }

  fun toMap(): Map<String, Any?> = mutableMapOf<String, Any?>(
    "id" to id,
    "type" to type,
    "scheduleId" to scheduleId,
    "alarmId" to alarmId,
    "occurrenceKey" to occurrenceKey,
    "at" to at,
  ).apply { detail?.let { put("detail", it) } }

  companion object {
    fun fromJson(o: JSONObject) = ObservedEvent(
      id = o.getString("id"),
      type = o.getString("type"),
      scheduleId = o.getString("scheduleId"),
      alarmId = o.getString("alarmId"),
      occurrenceKey = o.getString("occurrenceKey"),
      at = o.getString("at"),
      detail = if (o.isNull("detail")) null else o.getString("detail"),
    )
  }
}
