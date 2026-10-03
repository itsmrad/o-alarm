import { createPreferencesRepository } from '@/db/repositories/preferences';
import type { AppDatabase } from '@/db/types';

import { aiExplanationSchema, type AiExplanation } from './contract';

/**
 * Last Weekly Wake Report, kept on the device (preferences are local-only, not synced) so the
 * report still shows offline. Dropped by the local data wipe with the other preferences.
 */
export const AI_REPORT_CACHE_KEY = 'ai.weekly_report';

export interface CachedReport {
  /** Week covered (civil dates). */
  start: string;
  end: string;
  explanation: AiExplanation;
  savedAt: string;
}

export function readCachedReport(db: AppDatabase): CachedReport | null {
  try {
    const value = createPreferencesRepository(db, () => '').get<CachedReport>(AI_REPORT_CACHE_KEY);
    if (!value || typeof value.start !== 'string' || typeof value.end !== 'string') return null;
    const explanation = aiExplanationSchema.safeParse(value.explanation);
    return explanation.success ? { ...value, explanation: explanation.data } : null;
  } catch {
    return null;
  }
}

export function writeCachedReport(
  db: AppDatabase,
  report: Omit<CachedReport, 'savedAt'>,
  ctx: { now: Date; deviceId: string; newId: () => string },
): void {
  try {
    createPreferencesRepository(db, ctx.newId).set(
      AI_REPORT_CACHE_KEY,
      { ...report, savedAt: ctx.now.toISOString() } satisfies CachedReport,
      { now: ctx.now, deviceId: ctx.deviceId },
    );
  } catch {
    // Cache only: the report is still shown for this session.
  }
}
