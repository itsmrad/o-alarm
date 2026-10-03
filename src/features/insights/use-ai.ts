import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Crypto from 'expo-crypto';

import { MIN_MORNINGS_WEEK, type WakeAnalysis } from '@/domain/insights';
import {
  buildExplainRequest,
  buildWeeklyReportRequest,
  type BedtimePayload,
  type ExplainTopic,
  type InsightsAiRequest,
} from '@/domain/insights-payload';
import { usePaywall } from '@/features/paywall/use-paywall';
import {
  readCachedReport,
  requestAiExplanation,
  resolveAiAvailability,
  writeCachedReport,
  type AiAvailability,
  type AiExplanation,
  type AiUnavailableReason,
} from '@/lib/ai';
import { useAppServices } from '@/lib/app-services';
import { useAccount } from '@/lib/auth';
import { isSupabaseConfigured } from '@/lib/supabase';

export type AiState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ok'; explanation: AiExplanation }
  | { status: 'unavailable'; reason: AiUnavailableReason };

/** Explanations already fetched this session, keyed by their exact payload. */
const memory = new Map<string, AiExplanation>();
export const clearAiMemoryForTests = () => memory.clear();

export function useAiAvailability(): AiAvailability {
  const account = useAccount();
  const { isPro } = usePaywall();
  return resolveAiAvailability({
    configured: account.configured && isSupabaseConfigured(),
    signedIn: account.signedIn,
    isPro,
  });
}

function useAiRequest(request: InsightsAiRequest | null, onSuccess?: (e: AiExplanation) => void) {
  const { getToken } = useAccount();
  const key = request ? JSON.stringify(request) : null;
  const remembered = key ? memory.get(key) : undefined;
  const [state, setState] = useState<AiState>(
    remembered ? { status: 'ok', explanation: remembered } : { status: 'idle' },
  );
  // A new payload (new mornings) starts from what this session already knows about it.
  const lastKey = useRef(key);
  useEffect(() => {
    if (lastKey.current === key) return;
    lastKey.current = key;
    const known = key ? memory.get(key) : undefined;
    setState(known ? { status: 'ok', explanation: known } : { status: 'idle' });
  }, [key]);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(async () => {
    if (!request || !key) return;
    setState({ status: 'loading' });
    const outcome = await requestAiExplanation(request, { getToken });
    if (outcome.status === 'ok') {
      memory.set(key, outcome.explanation);
      onSuccess?.(outcome.explanation);
    }
    if (!mounted.current) return;
    setState(
      outcome.status === 'ok'
        ? { status: 'ok', explanation: outcome.explanation }
        : { status: 'unavailable', reason: outcome.reason },
    );
  }, [request, key, getToken, onSuccess]);

  return { state, run };
}

/**
 * Weekly Wake Report for the last complete week. Pro + signed in: fetched once (the server
 * also keeps one per week) and cached on the device, so it still shows offline. Otherwise the
 * deterministic week summary stands on its own.
 */
export function useWeeklyReport(analysis: WakeAnalysis, bedtime: BedtimePayload | null) {
  const { db, deviceId } = useAppServices();
  const availability = useAiAvailability();
  const week = analysis.lastWeek;
  const enoughData = week.mornings >= MIN_MORNINGS_WEEK;
  const request = useMemo(
    () => (enoughData ? buildWeeklyReportRequest(analysis, bedtime) : null),
    // The report is for a fixed past week; rebuild only when that week changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [enoughData, week.start, week.end],
  );
  const cached = useMemo(() => {
    const report = readCachedReport(db);
    return report && report.start === week.start && report.end === week.end ? report : null;
  }, [db, week.start, week.end]);

  const save = useCallback(
    (explanation: AiExplanation) =>
      writeCachedReport(
        db,
        { start: week.start, end: week.end, explanation },
        { now: new Date(), deviceId, newId: Crypto.randomUUID },
      ),
    [db, deviceId, week.start, week.end],
  );
  const { state, run } = useAiRequest(request, save);

  const autoRan = useRef(false);
  useEffect(() => {
    if (cached || autoRan.current || availability !== 'ready' || !request) return;
    autoRan.current = true;
    void run();
  }, [cached, availability, request, run]);

  const effective: AiState =
    cached && state.status !== 'ok' ? { status: 'ok', explanation: cached.explanation } : state;
  return { availability, enoughData, state: effective, retry: run };
}

/** On-demand explanation of one topic (bedtime, patterns, missions). Pro only. */
export function useExplanation(
  topic: ExplainTopic,
  analysis: WakeAnalysis,
  bedtime: BedtimePayload | null,
) {
  const availability = useAiAvailability();
  const request = useMemo(
    () => buildExplainRequest(topic, analysis, bedtime),
    [topic, analysis, bedtime],
  );
  const { state, run } = useAiRequest(request);
  return { availability, state, explain: run };
}
