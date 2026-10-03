/**
 * Integration surface of the sleep feature. Other features import from here only.
 *
 * - `endActiveSleepSession(at)`: call on alarm dismissal / Wake Check pass.
 * - `shouldPromptCheckIn(now)`: after wake, `router.push('/checkin')` when true.
 * - `SleepReminderSync`: mount once under AppServicesProvider to keep reminders current.
 * - Bedtime math is pure: `@/domain/sleep` (`recommendBedtime`, `upcomingWakeTargets`),
 *   stats for AI in `@/domain/sleep-stats` (`summarizeSleep`).
 */
export { endActiveSleepSession, getSleepService, shouldPromptCheckIn } from './sleep-runtime';
export type { MorningCheckIn, SleepService, SleepSession } from './sleep-service';
export {
  SleepReminderSync,
  refreshSleepReminders,
  useSleepReminderSync,
} from './use-sleep-reminders';
