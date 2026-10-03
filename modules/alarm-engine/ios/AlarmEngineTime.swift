import CryptoKit
import Foundation

// Pure time helpers. `resolveWallClock` is a port of src/domain/time.ts (D9) so native
// recomputation agrees with JS to the minute.

enum EngineTime {
  /// `Date.toISOString()` format: UTC with milliseconds, e.g. 2026-10-03T07:00:00.000Z.
  static func iso(_ date: Date) -> String {
    date.formatted(isoFractional)
  }

  /// Parses ISO-8601 instants with or without fractional seconds.
  static func parse(_ string: String) -> Date? {
    if let date = try? isoFractional.parse(string) { return date }
    return try? isoWhole.parse(string)
  }

  private static let isoFractional = Date.ISO8601FormatStyle(includingFractionalSeconds: true, timeZone: utc)
  private static let isoWhole = Date.ISO8601FormatStyle(includingFractionalSeconds: false, timeZone: utc)

  // swiftlint:disable:next force_unwrapping
  static let utc = TimeZone(identifier: "UTC")!

  /// The device zone, re-read after a system zone change.
  static func deviceTimeZone() -> TimeZone {
    NSTimeZone.resetSystemTimeZone()
    return TimeZone.current
  }

  // MARK: Civil dates (YYYY-MM-DD)

  struct CivilDate: Equatable, Sendable {
    var year: Int
    var month: Int
    var day: Int

    var formatted: String {
      String(format: "%04ld-%02ld-%02ld", year, month, day)
    }

    /// Days since 1970-01-01 (proleptic Gregorian), Howard Hinnant's algorithm.
    var dayNumber: Int {
      let y = month <= 2 ? year - 1 : year
      let era = (y >= 0 ? y : y - 399) / 400
      let yoe = y - era * 400
      let mp = (month + 9) % 12
      let doy = (153 * mp + 2) / 5 + day - 1
      let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
      return era * 146_097 + doe - 719_468
    }

    init(year: Int, month: Int, day: Int) {
      self.year = year
      self.month = month
      self.day = day
    }

    init(dayNumber: Int) {
      let z = dayNumber + 719_468
      let era = (z >= 0 ? z : z - 146_096) / 146_097
      let doe = z - era * 146_097
      let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365
      let doy = doe - (365 * yoe + yoe / 4 - yoe / 100)
      let mp = (5 * doy + 2) / 153
      let d = doy - (153 * mp + 2) / 5 + 1
      let m = mp < 10 ? mp + 3 : mp - 9
      self.init(year: yoe + era * 400 + (m <= 2 ? 1 : 0), month: m, day: d)
    }

    func adding(days: Int) -> CivilDate {
      CivilDate(dayNumber: dayNumber + days)
    }

    /// 0 = Sunday … 6 = Saturday (JS `Date.getUTCDay`). 1970-01-01 was a Thursday.
    var weekday: Int {
      ((dayNumber % 7) + 7 + 4) % 7
    }

    static func parse(_ string: String) -> CivilDate? {
      let parts = string.split(separator: "-", omittingEmptySubsequences: false)
      guard parts.count == 3, parts[0].count == 4, parts[1].count == 2, parts[2].count == 2,
            let year = Int(parts[0]), let month = Int(parts[1]), let day = Int(parts[2]),
            (1...12).contains(month), day >= 1
      else { return nil }
      let date = CivilDate(year: year, month: month, day: day)
      // Rejects 2026-02-30 and friends: a valid date survives the round trip.
      return CivilDate(dayNumber: date.dayNumber) == date ? date : nil
    }
  }

  /// The civil date of `instant` in `zone`.
  static func civilDate(of instant: Date, in zone: TimeZone) -> CivilDate {
    let local = instant.timeIntervalSince1970 + Double(zone.secondsFromGMT(for: instant))
    return CivilDate(dayNumber: Int((local / 86_400).rounded(.down)))
  }

  // MARK: Wall clock → instant (D9)

  /// Resolves a wall-clock time on a civil date in `zone` to an instant.
  /// - Normal: the unique instant.
  /// - DST overlap: the FIRST occurrence.
  /// - DST gap: the first valid instant after the gap (the transition instant).
  static func resolveWallClock(_ date: CivilDate, hour: Int, minute: Int, zone: TimeZone) -> Date {
    let minuteSeconds = 60.0
    let daySeconds = 86_400.0
    let naive = Double(date.dayNumber) * daySeconds + Double(hour * 60 + minute) * minuteSeconds
    func offset(_ instant: Double) -> Double {
      Double(zone.secondsFromGMT(for: Date(timeIntervalSince1970: instant)))
    }
    let before = offset(naive - daySeconds)
    let after = offset(naive + daySeconds)
    let candidates = Set([before, after])
      .map { naive - $0 }
      .filter { naive - offset($0) == $0 }
      .sorted()
    if let first = candidates.first {
      return Date(timeIntervalSince1970: first)
    }
    // Gap: find the transition instant between the two interpretations, minute resolution.
    var lo = min(naive - before, naive - after)
    var hi = max(naive - before, naive - after)
    while hi - lo > minuteSeconds {
      let mid = lo + max(1, ((hi - lo) / 2 / minuteSeconds).rounded(.down)) * minuteSeconds
      if offset(mid) == after { hi = mid } else { lo = mid }
    }
    return Date(timeIntervalSince1970: hi)
  }

  // MARK: Ids

  /// Deterministic AlarmKit id for a schedule id: re-scheduling the same id always maps to
  /// the same UUID, so an upsert replaces and never duplicates.
  static func alarmUUID(for scheduleId: String) -> UUID {
    let digest = SHA256.hash(data: Data("o-alarm.alarm-engine:\(scheduleId)".utf8))
    var bytes = Array(digest.prefix(16))
    bytes[6] = (bytes[6] & 0x0F) | 0x80 // RFC 9562 version 8 (custom, name-derived)
    bytes[8] = (bytes[8] & 0x3F) | 0x80 // RFC 4122 variant
    return UUID(uuid: (
      bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
      bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]
    ))
  }
}
