package com.oalarm.alarmengine

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class AlarmStoreTest {
  @get:Rule val tmp = TemporaryFolder()

  private fun file() = File(tmp.root, "alarm-engine/state.json")

  @Test fun roundTripsEverySpecFieldVerbatim() {
    val fixed = spec(id = "a2@2026-10-06", alarmId = "a2", wallClock = WallClock(6, 45, "2026-10-06", "Europe/Paris", listOf(1, 2)))
    val instantOnly = spec(id = "a1@2026-10-05#snooze-1", kind = ScheduleKinds.SNOOZE, wallClock = null)
    val store = AlarmStore(file())
    listOf(spec(), fixed, instantOnly).forEach { store.schedules[it.id] = ScheduledEntry(it, "2026-10-04T10:00:00.000Z") }
    store.ringing = RingingRecord(spec(), "2026-10-05T11:00:00.000Z", 1)
    store.snoozeCounts["a1@2026-10-05"] = 1
    store.lastZone = "America/New_York"
    store.appendEvent(ObservedEvent("e1", ObservedTypes.MISSED, "a1@2026-10-05", "a1", "a1@2026-10-05", "2026-10-05T12:00:00.000Z", "late"))
    store.save()

    val loaded = AlarmStore(file())
    assertNull(loaded.loadError)
    assertEquals(store.schedules, loaded.schedules)
    assertEquals(store.ringing, loaded.ringing)
    assertEquals(store.events, loaded.events)
    assertEquals(1, loaded.snoozeCounts["a1@2026-10-05"])
    assertEquals("America/New_York", loaded.lastZone)
    assertNull(loaded.schedules[instantOnly.id]!!.spec.wallClock)
    assertNull(loaded.schedules[spec().id]!!.spec.wallClock!!.timeZone)
  }

  @Test fun mapRoundTripMatchesTheJsShape() {
    val original = spec()
    assertEquals(original, AlarmSpec.fromMap(original.toMap()))
  }

  @Test fun bridgeNumbersArriveAsDoubles() {
    val map = spec().toMap().apply {
      put("snooze", mapOf("enabled" to true, "durationMin" to 9.0, "maxCount" to 2.0))
    }
    assertEquals(9, AlarmSpec.fromMap(map).snooze.durationMin)
  }

  @Test fun corruptFileStartsEmptyAndReports() {
    file().parentFile!!.mkdirs()
    file().writeText("{not json")
    val store = AlarmStore(file())
    assertNotNull(store.loadError)
    assertTrue(store.schedules.isEmpty())
    assertTrue(File(file().parentFile, "state.json.corrupt").exists())
  }

  @Test fun eventLogIsCapped() {
    val store = AlarmStore(file())
    repeat(AlarmStore.MAX_EVENTS + 10) {
      store.appendEvent(ObservedEvent("e$it", ObservedTypes.SNOOZED, "s", "a", "o", "2026-10-05T12:00:00.000Z", null))
    }
    assertEquals(AlarmStore.MAX_EVENTS, store.events.size)
    assertEquals("e10", store.events.first().id)
  }
}
