package com.oalarm.alarmengine

import java.io.File
import java.time.Instant
import java.time.ZoneId

class FakeOs : OsAlarmScheduler {
  val armed = LinkedHashMap<String, AlarmSpec>()
  var exactAllowed = true
  var failWith: Exception? = null

  override fun canScheduleExact() = exactAllowed

  override fun arm(spec: AlarmSpec) {
    failWith?.let { throw it }
    armed[spec.id] = spec
  }

  override fun cancel(id: String) {
    armed.remove(id)
  }

  override fun isArmed(id: String) = armed.containsKey(id)
}

class FakeRinger : Ringer {
  var rings = 0
  var stops = 0

  override fun ring() {
    rings++
  }

  override fun stop() {
    stops++
  }
}

class Harness(val file: File, start: Instant, zone: String = "America/New_York") {
  var now: Instant = start
  var zone: ZoneId = ZoneId.of(zone)
  val os = FakeOs()
  val ringer = FakeRinger()
  val core = newCore()

  /** A fresh engine over the same file, as after a reboot or process death. */
  fun newCore(os: OsAlarmScheduler = this.os, ringer: Ringer = this.ringer) =
    AlarmEngineCore(AlarmStore(file), os, ringer, { now }, { zone })
}

fun spec(
  id: String = "a1@2026-10-05",
  alarmId: String = "a1",
  kind: String = ScheduleKinds.ALARM,
  fireAt: String = "2026-10-05T11:00:00.000Z",
  wallClock: WallClock? = WallClock(7, 0, "2026-10-05", null, listOf(0, 1, 2, 3, 4, 5, 6)),
  snooze: SnoozeConfig = SnoozeConfig(true, 9, 2),
  hasMissions: Boolean = false,
) = AlarmSpec(
  id = id,
  alarmId = alarmId,
  occurrenceKey = if (kind == ScheduleKinds.ALARM) id else id.substringBefore('#'),
  kind = kind,
  fireAt = fireAt,
  wallClock = wallClock,
  label = "Wake up",
  sound = AlarmSound("default", null),
  vibration = true,
  escalation = Escalation(true, 30),
  snooze = snooze,
  hasMissions = hasMissions,
  wakeCheck = false,
  important = true,
)
