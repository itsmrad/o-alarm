package com.oalarm.alarmengine

import java.time.Duration
import java.time.Instant
import java.time.ZoneId
import java.util.UUID

/** The OS alarm boundary (AlarmManager in production, a fake in JVM tests). */
interface OsAlarmScheduler {
  fun canScheduleExact(): Boolean

  /** Arms or replaces the exact alarm for `spec.id`. Throws SecurityException without permission. */
  fun arm(spec: AlarmSpec)

  fun cancel(id: String)

  /** False when the OS certainly no longer holds the alarm. */
  fun isArmed(id: String): Boolean
}

/** Starts/stops the foreground ringing service (sound, vibration, full-screen UI). */
interface Ringer {
  /** Ring the store's current ringing record (idempotent). */
  fun ring()

  fun stop()
}

/** Delivers events to JS while the module is alive. */
fun interface EngineEventSink {
  fun emit(name: String, payload: Map<String, Any?>)
}

enum class RestoreReason(val logsRestore: Boolean) {
  BOOT(true),
  LOCKED_BOOT(true),
  PACKAGE_REPLACED(true),
  EXACT_ALARM_PERMISSION(true),
  TIME_SET(false),
  TIMEZONE_CHANGED(false),
  APP_START(false),
}

/**
 * Platform-independent engine logic: idempotent scheduling into the native mirror, ringing,
 * snooze / dismiss / wake-check, native recurrence (D28) and restore after boot / time / tz
 * changes without JS (D10, D13). Every public method is serialized on this instance.
 */
class AlarmEngineCore(
  private val store: AlarmStore,
  private val os: OsAlarmScheduler,
  private val ringer: Ringer,
  private val clock: () -> Instant = Instant::now,
  private val deviceZone: () -> ZoneId = ZoneId::systemDefault,
) {
  @Volatile var sink: EngineEventSink? = null

  init {
    store.loadError?.let {
      record(ObservedTypes.SCHEDULE_FAILED, "", "", "", "native mirror unreadable, reset: $it")
      persist()
    }
  }

  // ---- scheduling ----

  @Synchronized
  fun schedule(spec: AlarmSpec): ScheduledEntry {
    spec.validate()
    if (!spec.fireInstant.isAfter(clock().minusSeconds(PAST_TOLERANCE_SECONDS))) {
      throw EngineException(EngineException.INVALID_SPEC, "fireAt ${spec.fireAt} is in the past")
    }
    return arm(spec)
  }

  @Synchronized
  fun cancel(id: String) {
    os.cancel(id)
    if (store.schedules.remove(id) != null) persist()
  }

  @Synchronized
  fun cancelAll() {
    store.schedules.keys.forEach { os.cancel(it) }
    store.schedules.clear()
    persist()
  }

  /** What is really armed: mirror entries the OS still holds, none without exact-alarm access. */
  @Synchronized
  fun getScheduled(): List<ScheduledEntry> {
    if (!os.canScheduleExact()) return emptyList()
    return store.schedules.values.filter { os.isArmed(it.spec.id) }.sortedBy { it.spec.fireInstant }
  }

  @Synchronized
  fun getRinging(): RingingRecord? = store.ringing

  // ---- firing ----

  /** AlarmManager fired `id`. Unknown ids (cancelled meanwhile) are ignored. */
  @Synchronized
  fun onFire(id: String) {
    val entry = store.schedules.remove(id) ?: return
    val now = clock()
    if (Duration.between(entry.spec.fireInstant, now) > LATE_GRACE) {
      record(ObservedTypes.MISSED, entry.spec, "fired ${Duration.between(entry.spec.fireInstant, now).toMinutes()} min late")
      armNextRecurrence(entry.spec)
      persist()
      return
    }
    startRinging(entry.spec, now)
    armNextRecurrence(entry.spec)
    persist()
  }

  /** Rings `spec` now through the real path without storing it as a schedule. */
  @Synchronized
  fun preview(spec: AlarmSpec) {
    spec.validate()
    startRinging(spec, clock())
    persist()
  }

  private fun startRinging(spec: AlarmSpec, now: Instant) {
    val record = RingingRecord(spec, isoString(now), store.snoozeCounts[spec.occurrenceKey] ?: 0)
    record(ObservedTypes.TRIGGER_RECEIVED, spec, null)
    val current = store.ringing
    // D37: a retrigger firing while a wake-check prompt rings stops the prompt and rings.
    val preempts = current != null && spec.kind == ScheduleKinds.RETRIGGER && current.spec.kind == ScheduleKinds.WAKE_CHECK
    if (current == null || preempts) {
      store.ringing = record
      persist()
      ringer.ring()
    } else {
      store.pendingRings.add(record)
    }
    emit("onTrigger", payload(spec, now))
  }

  // ---- ringing control ----

  @Synchronized
  fun snooze(scheduleId: String): ScheduledEntry {
    val ringing = requireRinging(scheduleId)
    val spec = ringing.spec
    if (!spec.snooze.enabled || ringing.snoozeCount >= spec.snooze.maxCount) {
      throw EngineException(
        EngineException.SNOOZE_LIMIT,
        "snooze limit reached (${ringing.snoozeCount}/${if (spec.snooze.enabled) spec.snooze.maxCount else 0})",
      )
    }
    val n = ringing.snoozeCount + 1
    val now = clock()
    val snoozeSpec = spec.copy(
      id = "${spec.occurrenceKey}#snooze-$n",
      kind = ScheduleKinds.SNOOZE,
      fireAt = isoString(now.plus(Duration.ofMinutes(spec.snooze.durationMin.toLong()))),
      wallClock = null,
    )
    // Arm first: if it fails the alarm keeps ringing and the caller gets the error.
    val entry = arm(snoozeSpec)
    store.snoozeCounts[spec.occurrenceKey] = n
    record(ObservedTypes.SNOOZED, spec, "snooze $n of ${spec.snooze.maxCount}")
    finishRinging()
    emit("onSnooze", payload(spec, now))
    return entry
  }

  @Synchronized
  fun dismiss(scheduleId: String, missionCompleted: Boolean, wakeCheckAt: String?): ScheduledEntry? {
    val ringing = requireRinging(scheduleId)
    val spec = ringing.spec
    val now = clock()
    var wakeCheck: ScheduledEntry? = null
    if (wakeCheckAt != null) {
      val at = parseInstant(wakeCheckAt, "wakeCheckAt")
      if (!at.isAfter(now)) throw EngineException(EngineException.INVALID_SPEC, "wakeCheckAt $wakeCheckAt is not in the future")
      val attempt = (store.wakeCheckAttempts[spec.occurrenceKey] ?: 0) + 1
      // D13: armed before ringing stops, so a failure leaves the alarm ringing.
      wakeCheck = arm(
        spec.copy(
          id = "${spec.occurrenceKey}#wake-check-$attempt",
          kind = ScheduleKinds.WAKE_CHECK,
          fireAt = isoString(at),
          wallClock = null,
        ),
      )
      store.wakeCheckAttempts[spec.occurrenceKey] = attempt
    }
    store.snoozeCounts.remove(spec.occurrenceKey)
    record(ObservedTypes.DISMISSED, spec, if (missionCompleted) null else "mission_not_completed")
    finishRinging()
    emit("onDismiss", payload(spec, now))
    return wakeCheck
  }

  private fun requireRinging(scheduleId: String): RingingRecord {
    val ringing = store.ringing
    if (ringing == null || ringing.scheduleId != scheduleId) {
      throw EngineException(EngineException.NOT_RINGING, "$scheduleId is not ringing")
    }
    return ringing
  }

  /** Stops the current ring and starts the next queued one, if any. */
  private fun finishRinging() {
    val next = if (store.pendingRings.isEmpty()) null else store.pendingRings.removeAt(0)
    store.ringing = next?.copy(snoozeCount = store.snoozeCounts[next.spec.occurrenceKey] ?: 0)
    store.pruneCounters()
    persist()
    if (next != null) ringer.ring() else ringer.stop()
  }

  // ---- observed events ----

  @Synchronized
  fun drainEvents(): List<ObservedEvent> = store.events.toList()

  @Synchronized
  fun ackEvents(ids: Collection<String>) {
    val set = ids.toHashSet()
    if (store.events.removeAll { it.id in set }) persist()
  }

  // ---- restore (boot, time/tz change, upgrade, permission re-grant, app start) ----

  /**
   * Re-arms the whole mirror without JS. Floating `alarm` entries are recomputed in the
   * current device zone (D9); instants that already passed ring now if within the grace
   * period, otherwise they are reported `missed` and the next recurrence is armed (D28).
   */
  @Synchronized
  fun restore(reason: RestoreReason) {
    val now = clock()
    val zone = deviceZone()
    for (entry in store.schedules.values.toList()) {
      var spec = entry.spec
      val wc = spec.wallClock
      if (spec.kind == ScheduleKinds.ALARM && wc != null && wc.timeZone == null) {
        val recomputed = isoString(Recurrence.resolve(wc.date, wc.hour, wc.minute, zone))
        if (Instant.parse(recomputed) != spec.fireInstant) {
          spec = spec.copy(fireAt = recomputed)
          store.schedules[spec.id] = entry.copy(spec = spec)
          record(ObservedTypes.TZ_CHANGE_RESCHEDULED, spec, "${entry.spec.fireAt} -> $recomputed in ${zone.id}")
        }
      }
      if (!spec.fireInstant.isAfter(now)) {
        store.schedules.remove(spec.id)
        os.cancel(spec.id)
        if (Duration.between(spec.fireInstant, now) <= LATE_GRACE) {
          startRinging(spec, now)
        } else {
          record(ObservedTypes.MISSED, spec, "not rung before ${reason.name.lowercase()}")
        }
        armNextRecurrence(spec)
        continue
      }
      try {
        os.arm(spec)
        if (reason.logsRestore) record(ObservedTypes.RESTORED_AFTER_BOOT, spec, reason.name.lowercase())
      } catch (e: Exception) {
        record(ObservedTypes.SCHEDULE_FAILED, spec, "${errorCode(e)}: ${e.message}")
      }
    }
    store.lastZone = zone.id
    resumeRinging(now)
    persist()
  }

  /** After a reboot or process death the ringing alarm resumes until explicitly stopped. */
  private fun resumeRinging(now: Instant) {
    val ringing = store.ringing ?: return
    if (Duration.between(Instant.parse(ringing.firedAt), now) > STALE_RING) {
      record(ObservedTypes.MISSED, ringing.spec, "ringing interrupted and never stopped")
      store.ringing = null
      finishRinging()
      return
    }
    ringer.ring()
  }

  // ---- internals ----

  private fun arm(spec: AlarmSpec): ScheduledEntry {
    if (!os.canScheduleExact()) {
      throw EngineException(EngineException.PERMISSION_DENIED, "exact alarm permission (Alarms & reminders) is not granted")
    }
    try {
      os.arm(spec)
    } catch (e: SecurityException) {
      throw EngineException(EngineException.PERMISSION_DENIED, e.message ?: "exact alarm permission denied", e)
    } catch (e: Exception) {
      throw EngineException(EngineException.SCHEDULE_FAILED, e.message ?: e.javaClass.simpleName, e)
    }
    val entry = ScheduledEntry(spec, isoString(clock()))
    store.schedules[spec.id] = entry
    try {
      persist()
    } catch (e: Exception) {
      store.schedules.remove(spec.id)
      os.cancel(spec.id)
      throw EngineException(EngineException.SCHEDULE_FAILED, "could not persist the native mirror: ${e.message}", e)
    }
    return entry
  }

  /**
   * D28: after an `alarm` occurrence rang (or was missed), arm the occurrence after the
   * alarm's latest mirrored one, so recurring alarms keep ringing when JS never runs.
   * Ids match JS (`<alarmId>@<localDate>`), so the next reconcile replaces, never duplicates.
   */
  private fun armNextRecurrence(fired: AlarmSpec) {
    if (fired.kind != ScheduleKinds.ALARM || fired.wallClock == null) return
    val latest = (store.schedules.values.map { it.spec } + fired)
      .filter { it.alarmId == fired.alarmId && it.kind == ScheduleKinds.ALARM && it.wallClock != null }
      .maxByOrNull { it.wallClock!!.date }!!
    val rule = latest.wallClock!!
    if (rule.weekdays.isEmpty()) return
    val zone = rule.zone(deviceZone())
    val (date, instant) = Recurrence.nextOccurrence(rule, rule.date, zone, clock()) ?: return
    val key = "${fired.alarmId}@$date"
    if (store.schedules.containsKey(key)) return
    val next = latest.copy(
      id = key,
      occurrenceKey = key,
      fireAt = isoString(instant),
      wallClock = rule.copy(localDate = date.toString()),
    )
    try {
      arm(next)
    } catch (e: Exception) {
      record(ObservedTypes.SCHEDULE_FAILED, next, "${errorCode(e)}: ${e.message}")
    }
  }

  private fun record(type: String, spec: AlarmSpec, detail: String?) =
    record(type, spec.id, spec.alarmId, spec.occurrenceKey, detail)

  private fun record(type: String, scheduleId: String, alarmId: String, occurrenceKey: String, detail: String?) {
    store.appendEvent(
      ObservedEvent(UUID.randomUUID().toString(), type, scheduleId, alarmId, occurrenceKey, isoString(clock()), detail),
    )
  }

  private fun persist() = store.save()

  private fun emit(name: String, body: Map<String, Any?>) {
    try {
      sink?.emit(name, body)
    } catch (_: Exception) {
      // JS gone mid-emit: the observed-event log still has it.
    }
  }

  private fun payload(spec: AlarmSpec, at: Instant): Map<String, Any?> = mapOf(
    "scheduleId" to spec.id,
    "alarmId" to spec.alarmId,
    "occurrenceKey" to spec.occurrenceKey,
    "kind" to spec.kind,
    "at" to isoString(at),
  )

  private fun errorCode(e: Exception): String = (e as? EngineException)?.code ?: when (e) {
    is SecurityException -> EngineException.PERMISSION_DENIED
    else -> EngineException.SCHEDULE_FAILED
  }

  companion object {
    /** A fire instant this late (device off, clock jump) counts as missed, not rung. */
    val LATE_GRACE: Duration = Duration.ofMinutes(10)

    /** A ring interrupted by reboot / process death resumes only within this window. */
    val STALE_RING: Duration = Duration.ofHours(1)

    /** JS computes fireAt a moment before calling schedule. */
    const val PAST_TOLERANCE_SECONDS = 5L
  }
}
