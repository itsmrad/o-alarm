import type { Href } from 'expo-router';

/**
 * Mission hook point between the ringing flow and the mission screen (app/mission.tsx,
 * owned by the missions feature).
 *
 * Ringing → `router.push(missionGateHref(params))` when the alarm needs a mission before
 * dismissing (`hasMissions`) or snoozing (`missionBeforeSnooze`). The mission screen:
 *   1. `const params = parseMissionGateParams(useLocalSearchParams())`
 *   2. runs the alarm's chain (`useAppServices().alarms.get(params.alarmId).missions`)
 *   3. on success: `await useAppServices().ring.completeMission(params)` then `router.back()`
 *      — the ringing screen sees the alarm stopped and closes itself.
 *   4. on abandon: `router.back()` only; the alarm keeps ringing.
 * `engine.dismiss`/`engine.snooze` are only ever called by `completeMission` after success.
 */
export type MissionPurpose = 'dismiss' | 'snooze';

export interface MissionGateParams {
  purpose: MissionPurpose;
  /** The ringing engine schedule id (`RingingState.scheduleId`). */
  scheduleId: string;
  alarmId: string;
  occurrenceKey: string;
}

export function missionGateHref(params: MissionGateParams): Href {
  return { pathname: '/mission', params: { ...params } };
}

type RawParams = Record<string, string | string[] | undefined>;

const single = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

/** Null when the route was opened without a ringing alarm (e.g. a mission preview). */
export function parseMissionGateParams(raw: RawParams): MissionGateParams | null {
  const purpose = single(raw.purpose);
  const scheduleId = single(raw.scheduleId);
  const alarmId = single(raw.alarmId);
  const occurrenceKey = single(raw.occurrenceKey);
  if ((purpose !== 'dismiss' && purpose !== 'snooze') || !scheduleId || !alarmId) return null;
  return { purpose, scheduleId, alarmId, occurrenceKey: occurrenceKey ?? '' };
}
