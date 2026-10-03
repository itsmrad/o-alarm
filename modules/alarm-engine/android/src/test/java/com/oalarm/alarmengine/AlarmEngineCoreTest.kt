package com.oalarm.alarmengine

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.time.Duration
import java.time.Instant
import java.time.ZoneId

class AlarmEngineCoreTest {
  @get:Rule val tmp = TemporaryFolder()

  private lateinit var h: Harness
  private val core get() = h.core

  @Before fun setUp() {
    h = Harness(File(tmp.root, "state.json"), Instant.parse("2026-10-04T12:00:00Z"))
  }

  private fun expectCode(code: String, block: () -> Unit) {
    try {
      block()
      fail("expected $code")
    } catch (e: EngineException) {
      assertEquals(code, e.code)
    }
  }

  private fun eventTypes() = core.drainEvents().map { it.type }

  // ---- scheduling ----

  @Test fun scheduleIsAnIdempotentUpsert() {
    core.schedule(spec())
    core.schedule(spec(fireAt = "2026-10-05T11:05:00.000Z"))
    assertEquals(1, core.getScheduled().size)
    assertEquals("2026-10-05T11:05:00.000Z", core.getScheduled().single().spec.fireAt)
    assertEquals(1, h.os.armed.size)
  }

  @Test fun readBackReturnsTheSpecVerbatimWithScheduledAt() {
    val entry = core.schedule(spec())
    assertEquals(spec(), entry.spec)
    assertEquals("2026-10-04T12:00:00.000Z", entry.scheduledAt)
  }

  @Test fun scheduleFailuresAreTyped() {
    expectCode(EngineException.INVALID_SPEC) { core.schedule(spec(id = "")) }
    expectCode(EngineException.INVALID_SPEC) { core.schedule(spec(fireAt = "tomorrow")) }
    expectCode(EngineException.INVALID_SPEC) { core.schedule(spec(fireAt = "2026-10-04T11:00:00.000Z")) }
    h.os.exactAllowed = false
    expectCode(EngineException.PERMISSION_DENIED) { core.schedule(spec()) }
    h.os.exactAllowed = true
    h.os.failWith = SecurityException("revoked")
    expectCode(EngineException.PERMISSION_DENIED) { core.schedule(spec()) }
    h.os.failWith = IllegalStateException("too many alarms")
    expectCode(EngineException.SCHEDULE_FAILED) { core.schedule(spec()) }
    assertTrue(core.getScheduled().isEmpty())
  }

  @Test fun withoutExactAlarmAccessNothingReadsBackAsScheduled() {
    core.schedule(spec())
    h.os.exactAllowed = false
    assertTrue(core.getScheduled().isEmpty())
  }

  @Test fun cancelIsIdempotent() {
    core.schedule(spec())
    core.cancel(spec().id)
    core.cancel(spec().id)
    core.cancel("unknown")
    assertTrue(core.getScheduled().isEmpty())
    assertTrue(h.os.armed.isEmpty())
  }

  // ---- firing & recurrence (D28) ----

  @Test fun firingRingsAndArmsTheNextRecurrenceAfterTheLatestOccurrence() {
    core.schedule(spec())
    core.schedule(spec(id = "a1@2026-10-06", fireAt = "2026-10-06T11:00:00.000Z", wallClock = WallClock(7, 0, "2026-10-06", null, (0..6).toList())))
    h.now = Instant.parse("2026-10-05T11:00:01Z")
    core.onFire("a1@2026-10-05")

    assertEquals("a1@2026-10-05", core.getRinging()!!.scheduleId)
    assertEquals(1, h.ringer.rings)
    assertEquals(listOf("a1@2026-10-06", "a1@2026-10-07"), core.getScheduled().map { it.spec.id })
    val next = core.getScheduled().last().spec
    assertEquals("2026-10-07T11:00:00.000Z", next.fireAt)
    assertEquals("2026-10-07", next.wallClock!!.localDate)
    assertEquals(listOf(ObservedTypes.TRIGGER_RECEIVED), eventTypes())
  }

  @Test fun oneTimeAlarmsDoNotRecur() {
    core.schedule(spec(wallClock = WallClock(7, 0, "2026-10-05", null, emptyList())))
    h.now = Instant.parse("2026-10-05T11:00:00Z")
    core.onFire(spec().id)
    assertTrue(core.getScheduled().isEmpty())
  }

  @Test fun cancelledAlarmFiringLateIsIgnored() {
    core.schedule(spec())
    core.cancel(spec().id)
    core.onFire(spec().id)
    assertNull(core.getRinging())
  }

  @Test fun nearbyAlarmsQueueInsteadOfDropping() {
    core.schedule(spec())
    core.schedule(spec(id = "b1@2026-10-05", alarmId = "b1", fireAt = "2026-10-05T11:01:00.000Z", wallClock = null))
    h.now = Instant.parse("2026-10-05T11:00:00Z")
    core.onFire("a1@2026-10-05")
    h.now = Instant.parse("2026-10-05T11:01:00Z")
    core.onFire("b1@2026-10-05")
    assertEquals("a1@2026-10-05", core.getRinging()!!.scheduleId)

    core.dismiss("a1@2026-10-05", missionCompleted = true, wakeCheckAt = null)
    assertEquals("b1@2026-10-05", core.getRinging()!!.scheduleId)
    core.dismiss("b1@2026-10-05", missionCompleted = true, wakeCheckAt = null)
    assertNull(core.getRinging())
    assertEquals(1, h.ringer.stops)
  }

  // ---- snooze ----

  @Test fun snoozeArmsReTriggersUpToTheLimit() {
    core.schedule(spec())
    h.now = Instant.parse("2026-10-05T11:00:00Z")
    core.onFire(spec().id)

    val first = core.snooze(spec().id)
    assertEquals("a1@2026-10-05#snooze-1", first.spec.id)
    assertEquals(ScheduleKinds.SNOOZE, first.spec.kind)
    assertEquals("2026-10-05T11:09:00.000Z", first.spec.fireAt)
    assertNull(first.spec.wallClock)
    assertNull(core.getRinging())

    h.now = Instant.parse("2026-10-05T11:09:00Z")
    core.onFire(first.spec.id)
    assertEquals(1, core.getRinging()!!.snoozeCount)
    val second = core.snooze(first.spec.id)
    assertEquals("a1@2026-10-05#snooze-2", second.spec.id)

    h.now = Instant.parse("2026-10-05T11:18:00Z")
    core.onFire(second.spec.id)
    assertEquals(2, core.getRinging()!!.snoozeCount)
    expectCode(EngineException.SNOOZE_LIMIT) { core.snooze(second.spec.id) }
    assertEquals(second.spec.id, core.getRinging()!!.scheduleId) // still ringing
  }

  @Test fun snoozeSurvivesProcessDeath() {
    core.schedule(spec())
    h.now = Instant.parse("2026-10-05T11:00:00Z")
    core.onFire(spec().id)
    core.snooze(spec().id)

    val revived = h.newCore()
    h.now = Instant.parse("2026-10-05T11:09:00Z")
    revived.onFire("a1@2026-10-05#snooze-1")
    assertEquals(1, revived.getRinging()!!.snoozeCount)
  }

  @Test fun snoozeDisabledOrWrongIdIsRejected() {
    core.schedule(spec(snooze = SnoozeConfig(false, 9, 3)))
    expectCode(EngineException.NOT_RINGING) { core.snooze(spec().id) }
    h.now = Instant.parse("2026-10-05T11:00:00Z")
    core.onFire(spec().id)
    expectCode(EngineException.NOT_RINGING) { core.snooze("other") }
    expectCode(EngineException.SNOOZE_LIMIT) { core.snooze(spec().id) }
  }

  // ---- dismiss & wake check (D13) ----

  @Test fun dismissArmsTheWakeCheckBeforeStopping() {
    core.schedule(spec())
    h.now = Instant.parse("2026-10-05T11:00:00Z")
    core.onFire(spec().id)
    val wakeCheck = core.dismiss(spec().id, missionCompleted = true, wakeCheckAt = "2026-10-05T11:10:00.000Z")!!
    assertEquals("a1@2026-10-05#wake-check-1", wakeCheck.spec.id)
    assertEquals(ScheduleKinds.WAKE_CHECK, wakeCheck.spec.kind)
    assertTrue(h.os.armed.containsKey(wakeCheck.spec.id))
    assertNull(core.getRinging())
    assertEquals(1, h.ringer.stops)
  }

  @Test fun badWakeCheckInstantKeepsTheAlarmRinging() {
    core.schedule(spec())
    h.now = Instant.parse("2026-10-05T11:00:00Z")
    core.onFire(spec().id)
    expectCode(EngineException.INVALID_SPEC) { core.dismiss(spec().id, true, "2026-10-05T10:00:00.000Z") }
    expectCode(EngineException.INVALID_SPEC) { core.dismiss(spec().id, true, "soon") }
    assertEquals(spec().id, core.getRinging()!!.scheduleId)
    assertEquals(0, h.ringer.stops)
  }

  // ---- restore: boot / tz / time (D10) ----

  @Test fun bootRestoreReArmsTheMirrorWithoutJs() {
    core.schedule(spec())
    core.schedule(spec(id = "a1@2026-10-05#snooze-1", kind = ScheduleKinds.SNOOZE, fireAt = "2026-10-05T11:30:00.000Z", wallClock = null))
    val rebootedOs = FakeOs() // the OS forgets every alarm on reboot
    val booted = h.newCore(os = rebootedOs)
    booted.restore(RestoreReason.LOCKED_BOOT)
    assertEquals(setOf("a1@2026-10-05", "a1@2026-10-05#snooze-1"), rebootedOs.armed.keys)
    assertEquals(
      listOf(ObservedTypes.RESTORED_AFTER_BOOT, ObservedTypes.RESTORED_AFTER_BOOT),
      booted.drainEvents().map { it.type },
    )
  }

  @Test fun bootAfterTheFireTimeRingsWithinGraceOtherwiseReportsMissed() {
    core.schedule(spec())
    core.schedule(spec(id = "b1@2026-10-05", alarmId = "b1", fireAt = "2026-10-05T10:00:00.000Z", wallClock = WallClock(6, 0, "2026-10-05", null, listOf(1))))
    h.now = Instant.parse("2026-10-05T11:05:00Z") // a1 is 5 min late, b1 is 65 min late
    val booted = h.newCore(os = FakeOs())
    booted.restore(RestoreReason.BOOT)

    assertEquals("a1@2026-10-05", booted.getRinging()!!.scheduleId)
    val events = booted.drainEvents()
    assertTrue(events.any { it.type == ObservedTypes.TRIGGER_RECEIVED && it.scheduleId == "a1@2026-10-05" })
    assertTrue(events.any { it.type == ObservedTypes.MISSED && it.scheduleId == "b1@2026-10-05" })
    // Weekly b1 (Mondays) re-arms next Monday.
    assertTrue(booted.getScheduled().any { it.spec.id == "b1@2026-10-12" })
  }

  @Test fun timeZoneChangeRecomputesFloatingAlarmsOnly() {
    core.schedule(spec()) // floating 07:00
    core.schedule(spec(id = "f1@2026-10-05", alarmId = "f1", wallClock = WallClock(7, 0, "2026-10-05", "America/New_York", emptyList())))
    core.schedule(spec(id = "a1@2026-10-05#snooze-1", kind = ScheduleKinds.SNOOZE, fireAt = "2026-10-05T12:00:00.000Z", wallClock = null))

    h.zone = ZoneId.of("Europe/London")
    core.restore(RestoreReason.TIMEZONE_CHANGED)

    val byId = core.getScheduled().associateBy { it.spec.id }
    assertEquals("2026-10-05T06:00:00.000Z", byId["a1@2026-10-05"]!!.spec.fireAt) // 07:00 BST
    assertEquals("2026-10-05T11:00:00.000Z", byId["f1@2026-10-05"]!!.spec.fireAt)
    assertEquals("2026-10-05T12:00:00.000Z", byId["a1@2026-10-05#snooze-1"]!!.spec.fireAt)
    assertEquals("2026-10-05T06:00:00.000Z", h.os.armed["a1@2026-10-05"]!!.fireAt)
    assertEquals(listOf(ObservedTypes.TZ_CHANGE_RESCHEDULED), eventTypes())
    // The recomputed instant persists across process death.
    assertEquals("2026-10-05T06:00:00.000Z", h.newCore().getScheduled().first { it.spec.id == "a1@2026-10-05" }.spec.fireAt)
  }

  @Test fun timeZoneChangeIntoThePastReportsMissedAndArmsTheNextDay() {
    core.schedule(spec()) // 07:00 NY = 11:00Z
    h.now = Instant.parse("2026-10-05T09:00:00Z")
    h.zone = ZoneId.of("Asia/Tokyo") // 07:00 JST on 10-05 = 2026-10-04T22:00Z, long gone
    core.restore(RestoreReason.TIMEZONE_CHANGED)
    val events = eventTypes()
    assertTrue(ObservedTypes.MISSED in events)
    assertEquals(listOf("a1@2026-10-06"), core.getScheduled().map { it.spec.id })
    assertEquals("2026-10-05T22:00:00.000Z", core.getScheduled().single().spec.fireAt)
  }

  @Test fun restoreFailuresAreRecordedNotSwallowed() {
    core.schedule(spec())
    val broken = FakeOs().apply { failWith = SecurityException("no exact alarm") }
    val booted = h.newCore(os = broken)
    booted.restore(RestoreReason.BOOT)
    val event = booted.drainEvents().single()
    assertEquals(ObservedTypes.SCHEDULE_FAILED, event.type)
    assertTrue(event.detail!!.startsWith(EngineException.PERMISSION_DENIED))
  }

  @Test fun ringingResumesAfterProcessDeathButNotWhenStale() {
    core.schedule(spec())
    h.now = Instant.parse("2026-10-05T11:00:00Z")
    core.onFire(spec().id)

    val ringer = FakeRinger()
    h.now = h.now.plus(Duration.ofMinutes(20))
    h.newCore(ringer = ringer).restore(RestoreReason.APP_START)
    assertEquals(1, ringer.rings)

    val stale = FakeRinger()
    h.now = h.now.plus(Duration.ofHours(2))
    val core2 = h.newCore(ringer = stale)
    core2.restore(RestoreReason.BOOT)
    assertEquals(0, stale.rings)
    assertNull(core2.getRinging())
  }

  // ---- observed events ----

  @Test fun drainRepeatsUntilAcked() {
    core.schedule(spec())
    h.now = Instant.parse("2026-10-05T11:00:00Z")
    core.onFire(spec().id)
    val first = core.drainEvents()
    assertEquals(first, core.drainEvents())
    core.ackEvents(first.map { it.id } + "unknown")
    assertTrue(core.drainEvents().isEmpty())
  }

  @Test fun eventsEmitToJsWhenAlive() {
    val emitted = mutableListOf<String>()
    core.sink = EngineEventSink { name, _ -> emitted += name }
    core.schedule(spec())
    h.now = Instant.parse("2026-10-05T11:00:00Z")
    core.onFire(spec().id)
    core.snooze(spec().id)
    assertEquals(listOf("onTrigger", "onSnooze"), emitted)
    assertFalse(core.drainEvents().isEmpty())
  }
}
