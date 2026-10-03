package com.oalarm.alarmengine

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

class RecurrenceTest {
  private val ny = ZoneId.of("America/New_York")

  @Test fun resolvesPlainWallClock() {
    assertEquals(Instant.parse("2026-10-05T11:00:00Z"), Recurrence.resolve(LocalDate.parse("2026-10-05"), 7, 0, ny))
  }

  @Test fun dstGapFiresAtTheTransitionInstant() {
    // 2026-03-08 02:30 does not exist in New York; clocks jump 02:00 EST -> 03:00 EDT (07:00Z).
    assertEquals(Instant.parse("2026-03-08T07:00:00Z"), Recurrence.resolve(LocalDate.parse("2026-03-08"), 2, 30, ny))
  }

  @Test fun dstOverlapFiresAtTheFirstOccurrence() {
    // 2026-11-01 01:30 happens twice; the first is EDT (-04:00).
    assertEquals(Instant.parse("2026-11-01T05:30:00Z"), Recurrence.resolve(LocalDate.parse("2026-11-01"), 1, 30, ny))
  }

  @Test fun weekdaysMatchJsGetDay() {
    assertEquals(0, Recurrence.jsWeekday(LocalDate.parse("2026-10-04"))) // Sunday
    assertEquals(6, Recurrence.jsWeekday(LocalDate.parse("2026-10-03"))) // Saturday
  }

  @Test fun nextWeekdayOccurrenceSkipsNonMatchingDays() {
    // Mondays and Fridays at 07:00; after Monday 2026-10-05 comes Friday 2026-10-09.
    val rule = WallClock(7, 0, "2026-10-05", null, listOf(1, 5))
    val next = Recurrence.nextOccurrence(rule, rule.date, ny, Instant.parse("2026-10-05T11:00:00Z"))!!
    assertEquals(LocalDate.parse("2026-10-09"), next.first)
    assertEquals(Instant.parse("2026-10-09T11:00:00Z"), next.second)
  }

  @Test fun oneTimeRuleHasNoNextOccurrence() {
    val rule = WallClock(7, 0, "2026-10-05", null, emptyList())
    assertNull(Recurrence.nextOccurrence(rule, rule.date, ny, Instant.parse("2026-10-01T00:00:00Z")))
  }
}
