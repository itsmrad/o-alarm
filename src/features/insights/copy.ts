import type { StructuredInsight, WeekSummary } from '@/domain/insights';
import { missionRegistry } from '@/domain/missions-registry';
import type { Weekday } from '@/domain/time';

/**
 * Deterministic wording for insights (free tier, offline). Calm, brief, never medical and never
 * causal: sleep vs energy is always phrased as an association in the user's own check-ins.
 */

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export const weekdayName = (weekday: Weekday) => WEEKDAYS[weekday]!;
export const pct = (ratio: number) => `${Math.round(ratio * 100)}%`;

export function missionName(id: string): string {
  return missionRegistry.get(id)?.title ?? 'Other mission';
}

export const chainName = (chain: readonly string[]) => chain.map(missionName).join(' → ');

export function formatMinutes(minutes: number): string {
  const total = Math.round(minutes);
  if (total < 60) return `${total} min`;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "Early pattern" note for low-confidence findings, else the evidence count. */
export function evidenceNote(insight: StructuredInsight): string {
  const unit =
    insight.kind === 'sleep_energy'
      ? 'check-in'
      : insight.kind === 'consistency'
        ? 'night'
        : insight.kind === 'wake_check'
          ? 'check'
          : 'morning';
  const base = `Based on ${plural(insight.sampleSize, unit)}`;
  return insight.confidence === 'low' ? `Early pattern · ${base.toLowerCase()}` : base;
}

export function describeInsight(insight: StructuredInsight): { title: string; body: string } {
  const m = insight.metrics;
  switch (insight.kind) {
    case 'wake_success':
      return {
        title: `Up on ${pct(m.successRate ?? 0)} of mornings`,
        body: 'Mornings where the alarm was dismissed and did not need to ring again.',
      };
    case 'snoozing':
      return (m.avgSnoozes ?? 0) < 0.3
        ? { title: 'You rarely snooze', body: 'Most mornings you get up on the first ring.' }
        : {
            title: `About ${m.avgSnoozes} snoozes a morning`,
            body: 'A snooze limit or a mission before snoozing can make the first ring count.',
          };
    case 'dismissal_time':
      return {
        title: `About ${formatMinutes(m.medianDismissalMin ?? 0)} from first ring to up`,
        body: 'The typical time from the first ring until the alarm was dismissed, snoozes included.',
      };
    case 'wake_check':
      return {
        title: `Wake Check passed ${pct(m.passRate ?? 0)} of the time`,
        body: 'How often you answered the follow-up check after dismissing the alarm.',
      };
    case 'returned_to_sleep':
      return {
        title: `Drifted back to sleep on ${plural(m.retriggerMornings ?? 0, 'morning')}`,
        body: `The alarm rang again after an unanswered Wake Check on ${pct(m.retriggerRate ?? 0)} of mornings.`,
      };
    case 'difficult_weekday': {
      const day = weekdayName(insight.weekday ?? 1);
      return {
        title: `${day}s are harder`,
        body: `Up on ${pct(m.weekdaySuccessRate ?? 0)} of ${day}s vs ${pct(m.overallSuccessRate ?? 0)} overall, with ${m.weekdayAvgSnoozes ?? 0} snoozes on average.`,
      };
    }
    case 'mission_effectiveness': {
      const name = chainName(insight.chain ?? []);
      return m.runnerUpSuccessRate !== undefined
        ? {
            title: `${name} works best for you`,
            body: `Up on ${pct(m.successRate ?? 0)} of ${plural(m.uses ?? 0, 'morning')} with it, vs ${pct(m.runnerUpSuccessRate)} with your next most used missions.`,
          }
        : {
            title: `${name}: up on ${pct(m.successRate ?? 0)} of mornings`,
            body: 'No mission has clearly worked better than another yet.',
          };
    }
    case 'sleep_energy':
      return {
        title:
          (m.energyDiff ?? 0) > 0
            ? 'Energy tends to be higher after longer nights'
            : 'Energy was not lower after shorter nights',
        body: `Average morning energy ${m.avgEnergyEnoughSleep}/5 after longer nights, ${m.avgEnergyShortSleep}/5 after shorter ones. An association in your own check-ins, not a cause.`,
      };
    case 'consistency': {
      const score = m.consistencyScore ?? 0;
      return {
        title: `Schedule consistency ${score}/100`,
        body:
          score >= 70
            ? 'Your bed and wake times are regular.'
            : score < 40
              ? 'Your bed and wake times vary quite a bit from night to night.'
              : 'Your bed and wake times are fairly regular.',
      };
    }
  }
}

/** One line per available weekly figure; null figures are left out, never shown as zero. */
export function weekFigures(week: WeekSummary): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = [];
  if (week.successRate !== null) rows.push({ label: 'Up on time', value: pct(week.successRate) });
  if (week.avgSnoozes !== null)
    rows.push({ label: 'Snoozes / morning', value: `${week.avgSnoozes}` });
  if (week.medianDismissalMin !== null) {
    rows.push({ label: 'Ring to up', value: formatMinutes(week.medianDismissalMin) });
  }
  if (week.wakeCheckPassRate !== null) {
    rows.push({ label: 'Wake Check passed', value: pct(week.wakeCheckPassRate) });
  }
  if (week.avgSleepMin !== null)
    rows.push({ label: 'Avg sleep', value: formatMinutes(week.avgSleepMin) });
  if (week.sleepConsistency !== null) {
    rows.push({ label: 'Consistency', value: `${week.sleepConsistency}/100` });
  }
  if (week.avgEnergy !== null) rows.push({ label: 'Morning energy', value: `${week.avgEnergy}/5` });
  return rows;
}

export function formatWeekRange(start: string, end: string): string {
  const fmt = (d: string) => {
    const [y, mo, da] = d.split('-').map(Number);
    return new Date(Date.UTC(y!, mo! - 1, da!)).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    });
  };
  return `${fmt(start)} – ${fmt(end)}`;
}
