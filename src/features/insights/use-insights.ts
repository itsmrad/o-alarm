import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import * as Crypto from 'expo-crypto';

import { deviceTimeZone } from '@/db/alarm-service';
import { createEventsRepository } from '@/db/repositories/events';
import { createOccurrencesRepository } from '@/db/repositories/occurrences';
import type { Alarm, AppEvent, EventType } from '@/domain';
import { analyzeWake, PATTERN_WINDOW_DAYS, type WakeAnalysis } from '@/domain/insights';
import { bedtimePayload, type BedtimePayload } from '@/domain/insights-payload';
import {
  recommendBedtime,
  upcomingWakeTargets,
  type BedtimeRecommendation,
  type SleepPrefs,
} from '@/domain/sleep';
import { recentBedtimes, summarizeSleep } from '@/domain/sleep-stats';
import { sleepServiceFor } from '@/features/sleep';
import { useAlarms, useAppServices } from '@/lib/app-services';

/** Event types the analysis reads (everything else in the log is irrelevant here). */
const ANALYSIS_EVENTS: EventType[] = [
  'alarm_snoozed',
  'alarm_retriggered',
  'mission_started',
  'mission_completed',
  'mission_failed',
  'wake_check_passed',
  'wake_check_failed',
];
/** Window loaded from SQLite: the pattern window plus last week's head start. */
const LOAD_DAYS = PATTERN_WINDOW_DAYS + 7;
const EVENT_LIMIT = 2000;

export interface InsightsData {
  analysis: WakeAnalysis;
  bedtime: BedtimeRecommendation;
  /** Bedtime math as codes for the AI explainer (no clock times). */
  bedtimeAi: BedtimePayload;
  prefs: SleepPrefs;
  timeZone: string;
  alarms: readonly Alarm[];
}

/**
 * Local wake analysis for the Insights tab. Reads only through existing repositories and the
 * sleep service on the app's single connection (D35); recomputed whenever the tab gains focus.
 */
export function useInsightsData(): InsightsData {
  const { db, deviceId, ring } = useAppServices();
  const alarms = useAlarms();
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);
  useFocusEffect(refresh);
  useEffect(() => ring.subscribe(refresh), [ring, refresh]);
  const sleep = useMemo(() => sleepServiceFor({ db, deviceId }), [db, deviceId]);
  useEffect(() => sleep.subscribe(refresh), [sleep, refresh]);

  return useMemo(() => {
    const now = new Date();
    const timeZone = deviceTimeZone();
    const since = new Date(now.getTime() - LOAD_DAYS * 86_400_000);
    const occurrences = createOccurrencesRepository(db, Crypto.randomUUID).listRecent({
      since,
      statuses: ['dismissed', 'missed'],
      limit: 1000,
    });
    const eventsRepo = createEventsRepository(db, Crypto.randomUUID);
    const events: AppEvent[] = ANALYSIS_EVENTS.flatMap((type) =>
      eventsRepo
        .list({ type, limit: EVENT_LIMIT })
        .filter((e) => Date.parse(e.occurredAt) >= since.getTime()),
    );
    const prefs = sleep.getSleepPrefs();
    const sessions = sleep.listSessions({ since, limit: 400 });
    const checkIns = sleep.listCheckIns(LOAD_DAYS);

    const analysis = analyzeWake({
      now,
      timeZone,
      occurrences,
      events,
      sleepSessions: sessions,
      checkIns,
      desiredSleepMin: prefs.desiredSleepMin,
    });
    const target = upcomingWakeTargets(alarms, now, timeZone, 1)[0];
    const bedtime = recommendBedtime({
      now,
      timeZone,
      prefs,
      wake: target?.fireAt ?? null,
      recentBedtimes: recentBedtimes(sessions),
    });
    const summary = summarizeSleep(sessions, checkIns, {
      now,
      timeZone,
      desiredSleepMin: prefs.desiredSleepMin,
    });
    return {
      analysis,
      bedtime,
      bedtimeAi: bedtimePayload(bedtime, prefs, summary),
      prefs,
      timeZone,
      alarms,
    };
    // `version` is the invalidation signal for the repository reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, sleep, alarms, version]);
}
