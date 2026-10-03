package com.oalarm.alarmengine

import java.time.DayOfWeek
import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime
import java.time.ZoneId

/**
 * Native port of the D9 wall-clock rules in src/domain/time.ts (`resolveWallClock`):
 * - DST gap (wall time skipped): the transition instant, i.e. the first valid instant after it.
 * - DST overlap (wall time repeats): the first occurrence.
 */
object Recurrence {
  fun resolve(date: LocalDate, hour: Int, minute: Int, zone: ZoneId): Instant {
    val local = LocalDateTime.of(date, LocalTime.of(hour, minute))
    val rules = zone.rules
    val offsets = rules.getValidOffsets(local)
    if (offsets.isEmpty()) return rules.getTransition(local).instant
    // Overlap: the earlier offset in time is the larger one (before the clocks go back).
    return local.toInstant(offsets.maxByOrNull { it.totalSeconds }!!)
  }

  /** 0 = Sunday … 6 = Saturday, like JS `Date#getDay`. */
  fun jsWeekday(date: LocalDate): Int = if (date.dayOfWeek == DayOfWeek.SUNDAY) 0 else date.dayOfWeek.value

  /**
   * The first recurrence strictly after `afterDate` whose fire instant is after `now`,
   * or null for one-time rules. Mirrors the 15-day scan in src/domain/recurrence.ts.
   */
  fun nextOccurrence(rule: WallClock, afterDate: LocalDate, zone: ZoneId, now: Instant): Pair<LocalDate, Instant>? {
    if (rule.weekdays.isEmpty()) return null
    var date = afterDate.plusDays(1)
    repeat(MAX_SCAN_DAYS) {
      if (jsWeekday(date) in rule.weekdays) {
        val instant = resolve(date, rule.hour, rule.minute, zone)
        if (instant.isAfter(now)) return date to instant
      }
      date = date.plusDays(1)
    }
    return null
  }

  private const val MAX_SCAN_DAYS = 400
}
