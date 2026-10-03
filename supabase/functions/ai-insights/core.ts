// AI insights (PRODUCT.md "AI", D18/D19): contract, prompt, output validation and request handler.
// Pure TypeScript whose only import is zod, so the same file runs in the Edge Function (Deno, `zod`
// mapped in deno.json), in Jest, and gives the app its request/response types (src/lib/ai).
//
// The client sends ONLY deterministic aggregates + structured insights (src/domain/insights*.ts);
// the strict request schema rejects anything else (unknown keys, free text, timestamps finer than a
// day). The LLM only explains: its JSON is schema-checked, grounded against the insight ids it was
// given, and rejected if it uses causal/medical language or claims to change alarms. On any failure
// the caller gets `fallback` and keeps showing the deterministic insights.

import { z } from 'zod';

// ------------------------------------------------------------------------------------- request

const civilDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const count = z.number().int().min(0).max(100_000);
const ratio = z.number().min(0).max(1);
const fin = z.number().finite().min(-100_000).max(100_000);

export const INSIGHT_KINDS = [
  'wake_success',
  'snoozing',
  'dismissal_time',
  'wake_check',
  'returned_to_sleep',
  'difficult_weekday',
  'mission_effectiveness',
  'sleep_energy',
  'consistency',
] as const;

export const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

export const BEDTIME_RATIONALES = [
  'from_next_alarm',
  'manual_target',
  'includes_latency',
  'no_history',
  'aligned_with_history',
  'shift_capped',
  'sleep_below_goal',
  'bedtime_passed',
  'no_alarm',
] as const;

export const EXPLAIN_TOPICS = [
  'bedtime_recommendation',
  'wake_pattern',
  'mission_recommendation',
] as const;
export type ExplainTopic = (typeof EXPLAIN_TOPICS)[number];

export const insightPayloadSchema = z.strictObject({
  id: z.string().regex(/^[a-z_]{1,32}(:[0-6])?$/),
  kind: z.enum(INSIGHT_KINDS),
  tone: z.enum(['positive', 'neutral', 'attention']),
  confidence: z.enum(['low', 'medium', 'high']),
  sampleSize: count,
  metrics: z
    .record(z.string().regex(/^[a-zA-Z]{1,32}$/), fin)
    .refine((m) => Object.keys(m).length <= 12, 'too many metrics'),
  weekday: z.enum(WEEKDAY_NAMES).optional(),
  chain: z
    .array(z.string().regex(/^[a-z][a-z0-9_]{0,23}$/))
    .min(1)
    .max(5)
    .optional(),
});
export type InsightPayload = z.infer<typeof insightPayloadSchema>;

export const weekPayloadSchema = z.strictObject({
  start: civilDate,
  end: civilDate,
  mornings: count,
  successRate: ratio.nullable(),
  avgSnoozes: fin.nullable(),
  medianDismissalMin: fin.nullable(),
  missed: count,
  retriggerMornings: count,
  wakeChecksPassed: count,
  wakeChecksFailed: count,
  wakeCheckPassRate: ratio.nullable(),
  sleepNights: count,
  avgSleepMin: fin.nullable(),
  sleepConsistency: fin.nullable(),
  avgEnergy: fin.nullable(),
  checkIns: count,
});
export type WeekPayload = z.infer<typeof weekPayloadSchema>;

export const bedtimePayloadSchema = z.strictObject({
  status: z.enum(['ok', 'no_alarm']),
  rationale: z.array(z.enum(BEDTIME_RATIONALES)).max(BEDTIME_RATIONALES.length),
  desiredSleepMin: count,
  latencyMin: count,
  /** Minutes the recommendation moved from the ideal (positive = later). */
  shiftMin: fin,
  expectedSleepMin: fin.nullable(),
  avgSleepMin: fin.nullable(),
  consistencyScore: fin.nullable(),
  nightsBelowGoal: count,
  nights: count,
});
export type BedtimePayload = z.infer<typeof bedtimePayloadSchema>;

const period = z
  .strictObject({ start: civilDate, end: civilDate })
  .refine((p) => p.start <= p.end, 'period start after end');

export const aiRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    schemaVersion: z.literal(1),
    kind: z.literal('weekly_report'),
    period,
    week: weekPayloadSchema,
    insights: z.array(insightPayloadSchema).max(12),
    bedtime: bedtimePayloadSchema.nullable(),
  }),
  z.strictObject({
    schemaVersion: z.literal(1),
    kind: z.literal('explain'),
    topic: z.enum(EXPLAIN_TOPICS),
    period,
    insights: z.array(insightPayloadSchema).max(12),
    bedtime: bedtimePayloadSchema.nullable(),
  }),
]);
export type AiRequest = z.infer<typeof aiRequestSchema>;

/** `ai_insights.type` (and the rate-limit bucket) for a request. */
export function insightType(request: AiRequest): 'weekly_report' | ExplainTopic {
  return request.kind === 'weekly_report' ? 'weekly_report' : request.topic;
}

// ------------------------------------------------------------------------------------- output

export const aiExplanationSchema = z.strictObject({
  headline: z.string().trim().min(1).max(100),
  summary: z.string().trim().min(1).max(700),
  suggestions: z
    .array(
      z.strictObject({
        text: z.string().trim().min(1).max(240),
        /** Insight id the suggestion rests on, or `week` / `bedtime`. */
        basedOn: z.string().min(1).max(40),
      }),
    )
    .max(2),
});
export type AiExplanation = z.infer<typeof aiExplanationSchema>;

/** JSON Schema handed to OpenRouter `response_format` (lengths are enforced by zod afterwards). */
export const EXPLANATION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['headline', 'summary', 'suggestions'],
  properties: {
    headline: { type: 'string' },
    summary: { type: 'string' },
    suggestions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'basedOn'],
        properties: { text: { type: 'string' }, basedOn: { type: 'string' } },
      },
    },
  },
} as const;

/** What the app receives. `fallback`: show the deterministic insights only. */
export const aiResponseSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    explanation: aiExplanationSchema,
    model: z.string(),
    cached: z.boolean(),
  }),
  z.object({
    status: z.literal('fallback'),
    reason: z.enum(['not_configured', 'unavailable', 'invalid_output']),
  }),
]);
export type AiResponse = z.infer<typeof aiResponseSchema>;

/** Error bodies: 400 invalid_request, 401 unauthorized, 403 pro_required, 429 rate_limited. */
export type AiErrorCode = 'invalid_request' | 'unauthorized' | 'pro_required' | 'rate_limited';

const UNSAFE_PATTERNS: { reason: string; pattern: RegExp }[] = [
  // Causation (PRODUCT.md: never present correlation as causation).
  {
    reason: 'causal_language',
    pattern: /\b(caus(e|es|ed|ing)|because of|due to|leads? to|led to|results? in|resulted in)\b/i,
  },
  // Medical framing.
  {
    reason: 'medical_language',
    pattern:
      /\b(diagnos\w*|insomnia|apnea|apnoea|narcolepsy|disorder|medication|medicine|melatonin|supplement\w*|prescri\w*|treatment|therapy|clinical|symptom\w*|depression|anxiety)\b/i,
  },
  // The AI never changes alarms (PRODUCT.md); it must not claim it did or will.
  {
    reason: 'alarm_change_claim',
    pattern:
      /\b(i|we|o-alarm|the app)\s*('ve|'ll| have| has| will| am| are|'m)?\s*(now\s+|also\s+)?((chang|mov|updat|adjust|reschedul|disabl|enabl|creat|delet)(e|es|ed|ing)|set|sets|setting|turn(s|ed|ing)?|edit(s|ed|ing)?)\b[^.]*\balarm/i,
  },
  { reason: 'alarm_change_claim', pattern: /\bautomatically\b[^.]*\b(alarm|wake|snooze)/i },
  { reason: 'markup', pattern: /[<>{}]|```|https?:\/\//i },
];

export type ValidationResult =
  | { ok: true; value: AiExplanation }
  | { ok: false; reason: string };

/**
 * Parses and checks the model output: strict schema (extra keys such as an `action` are rejected),
 * suggestions grounded in the given insight ids, 1-2 suggestions for a report with findings, and no
 * causal, medical or alarm-changing language anywhere.
 */
export function validateExplanation(raw: unknown, request: AiRequest): ValidationResult {
  let data = raw;
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw);
    } catch {
      return { ok: false, reason: 'not_json' };
    }
  }
  const parsed = aiExplanationSchema.safeParse(data);
  if (!parsed.success) return { ok: false, reason: 'schema' };
  const value = parsed.data;

  const grounded = new Set<string>(['week', 'bedtime', ...request.insights.map((i) => i.id)]);
  if (value.suggestions.some((s) => !grounded.has(s.basedOn))) {
    return { ok: false, reason: 'ungrounded_suggestion' };
  }
  if (
    request.kind === 'weekly_report' &&
    request.insights.length > 0 &&
    value.suggestions.length === 0
  ) {
    return { ok: false, reason: 'missing_suggestion' };
  }
  const texts = [value.headline, value.summary, ...value.suggestions.map((s) => s.text)];
  for (const { reason, pattern } of UNSAFE_PATTERNS) {
    if (texts.some((t) => pattern.test(t))) return { ok: false, reason };
  }
  return { ok: true, value };
}

// ------------------------------------------------------------------------------------- prompt

export const SYSTEM_PROMPT = `You explain one person's wake-up statistics inside an alarm clock app.
The input is JSON that the app already computed from the person's own alarm history. Your job is to put it into calm, plain words.

Rules:
- Use only the findings and numbers in the input. Never invent data or mention numbers that are not there.
- These are patterns in one person's data, not health findings. Do not diagnose, name conditions, mention medication or supplements, or give medical advice.
- Describe associations, never causes. Write "on shorter nights, morning energy tended to be lower", not "short sleep causes low energy". Do not use the words cause, caused, causes, because of, due to, leads to or results in.
- Match the confidence field: for "low" confidence say it is early and based on only a few mornings.
- Suggestions are optional ideas the person can choose to try themselves, phrased like "You could try...". Each must rest on one finding: set basedOn to that finding's id, or "week" for the weekly totals, or "bedtime" for the bedtime plan. Give 1-2 suggestions for a weekly report, 0-2 otherwise.
- You cannot change alarms, missions or settings. Never say you changed, will change or automatically adjust anything.
- Tone: warm, brief and encouraging. No guilt, no alarmist wording, no emojis, no markdown, no links.
- headline: one short sentence (at most 12 words). summary: 2-4 short sentences.

Field guide: rates are fractions (0.8 means 80%). A morning is a "success" when the alarm was dismissed without ringing again. A "retrigger" means the alarm rang again because the Wake Check after dismissal got no answer, a sign of drifting back to sleep. Energy is a 1-5 self-rating from the morning check-in. consistencyScore is 0-100 (higher = more regular bed and wake times). Minutes are minutes, avgCompleteSec is seconds. chain lists missions done in order (math, shake, qr = scan a code, steps = walk). Bedtime rationale codes explain how the bedtime was computed; shiftMin is how far it was moved toward the person's usual bedtime to keep changes gradual.`;

export function buildUserMessage(request: AiRequest): string {
  const task =
    request.kind === 'weekly_report'
      ? 'Write the weekly wake report for this week.'
      : {
          bedtime_recommendation: "Explain tonight's bedtime recommendation.",
          wake_pattern: 'Explain the wake patterns found.',
          mission_recommendation: 'Explain which wake missions have worked best.',
        }[request.topic];
  return `${task}\n\n${JSON.stringify(request)}`;
}

// ------------------------------------------------------------------------------------- OpenRouter

export const DEFAULT_OPENROUTER_MODEL = 'anthropic/claude-sonnet-5.5';
export const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

export type Completer = (request: AiRequest, signal: AbortSignal) => Promise<string>;

/**
 * OpenRouter chat completion with strict JSON output. Data collection by providers is denied and
 * providers that cannot honor every parameter are skipped. Throws on any transport/API failure.
 */
export function createOpenRouterCompleter(options: {
  apiKey: string;
  model: string;
  fetch?: typeof fetch;
}): Completer {
  const doFetch = options.fetch ?? fetch;
  return async (request, signal) => {
    const response = await doFetch(OPENROUTER_URL, {
      method: 'POST',
      signal,
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        'content-type': 'application/json',
        'x-title': 'O-Alarm',
      },
      body: JSON.stringify({
        model: options.model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserMessage(request) },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'wake_explanation', strict: true, schema: EXPLANATION_JSON_SCHEMA },
        },
        reasoning: { effort: 'low' },
        max_tokens: 4000,
        provider: { data_collection: 'deny', require_parameters: true },
      }),
    });
    if (!response.ok) throw new Error(`OpenRouter ${response.status}`);
    const body = (await response.json()) as {
      choices?: { message?: { content?: unknown }; finish_reason?: string }[];
    };
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content) throw new Error('OpenRouter: empty completion');
    return content;
  };
}

// ------------------------------------------------------------------------------------- handler

/** Per user, rolling 7 days (D19 cost guard). */
export const RATE_LIMITS = { weekly_report: 1, explanation: 10 } as const;
export type QuotaBucket = keyof typeof RATE_LIMITS;
export const quotaBucket = (request: AiRequest): QuotaBucket =>
  request.kind === 'weekly_report' ? 'weekly_report' : 'explanation';

export const LLM_TIMEOUT_MS = 25_000;

export interface AiInsightsDeps {
  /** Clerk id of the caller, verified by Postgres under the caller's token (current_user_id()). */
  verifyCaller: (token: string) => Promise<string | null>;
  /** has_entitlement('pro') under the caller's token. */
  isPro: (token: string) => Promise<boolean>;
  /** The stored row for this user + insightType(request) + period, if any. */
  findStored: (userId: string, request: AiRequest) => Promise<StoredExplanation | null>;
  /** Atomically records one use if under the limit; returns a claim id, or null when limited. */
  claimQuota: (userId: string, bucket: QuotaBucket, limit: number) => Promise<string | null>;
  /** Gives a claim back (upstream failure: the user did not get an answer). */
  releaseQuota: (claimId: string) => Promise<void>;
  /** Null when OPENROUTER_API_KEY is not set. */
  complete: Completer | null;
  store: (userId: string, request: AiRequest, explanation: AiExplanation, model: string) => Promise<void>;
  model: string;
  timeoutMs?: number;
  log?: (message: string) => void;
}

/** An `ai_insights` row for the same user, type and period. */
export interface StoredExplanation {
  /** `structured.request`: the payload the explanation was written for. */
  request: unknown;
  explanation: unknown;
  model: string;
}

/**
 * A stored weekly report is reused for its (complete) week. A stored explanation is reused only
 * for an identical payload: new mornings mean new numbers, so it is explained again.
 */
export function reusableExplanation(stored: StoredExplanation, request: AiRequest): AiExplanation | null {
  const explanation = aiExplanationSchema.safeParse(stored.explanation);
  if (!explanation.success) return null;
  if (request.kind === 'weekly_report') return explanation.data;
  return JSON.stringify(stored.request) === JSON.stringify(request) ? explanation.data : null;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const error = (status: number, code: AiErrorCode) => json(status, { error: code });
const fallback = (reason: Extract<AiResponse, { status: 'fallback' }>['reason']) =>
  json(200, { status: 'fallback', reason } satisfies AiResponse);

export function createAiInsightsHandler(deps: AiInsightsDeps): (request: Request) => Promise<Response> {
  const log = deps.log ?? (() => undefined);
  const timeoutMs = deps.timeoutMs ?? LLM_TIMEOUT_MS;

  return async (req) => {
    if (req.method !== 'POST') return json(405, { error: 'method not allowed' });
    const token = /^Bearer (.+)$/.exec(req.headers.get('authorization') ?? '')?.[1];
    if (!token) return error(401, 'unauthorized');

    let userId: string | null;
    try {
      userId = await deps.verifyCaller(token);
    } catch {
      userId = null;
    }
    if (!userId) return error(401, 'unauthorized');

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return error(400, 'invalid_request');
    }
    const parsed = aiRequestSchema.safeParse(body);
    if (!parsed.success) return error(400, 'invalid_request');
    const request = parsed.data;

    let pro = false;
    try {
      pro = await deps.isPro(token);
    } catch {
      pro = false;
    }
    if (!pro) return error(403, 'pro_required');

    try {
      const stored = await deps.findStored(userId, request);
      const explanation = stored && reusableExplanation(stored, request);
      if (stored && explanation) {
        return json(200, {
          status: 'ok',
          explanation,
          model: stored.model,
          cached: true,
        } satisfies AiResponse);
      }
    } catch (e) {
      log(`ai-insights: cache read failed: ${message(e)}`);
    }

    if (!deps.complete) return fallback('not_configured');

    const bucket = quotaBucket(request);
    let claim: string | null;
    try {
      claim = await deps.claimQuota(userId, bucket, RATE_LIMITS[bucket]);
    } catch (e) {
      log(`ai-insights: quota check failed: ${message(e)}`);
      return fallback('unavailable');
    }
    if (!claim) return error(429, 'rate_limited');

    const complete = deps.complete;
    const controller = new AbortController();
    let raw: string;
    try {
      raw = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          controller.abort();
          reject(new Error(`timed out after ${timeoutMs} ms`));
        }, timeoutMs);
        complete(request, controller.signal)
          .then(resolve, reject)
          .finally(() => clearTimeout(timer));
      });
    } catch (e) {
      log(`ai-insights: completion failed: ${message(e)}`);
      await deps.releaseQuota(claim).catch(() => undefined);
      return fallback('unavailable');
    }

    const result = validateExplanation(raw, request);
    if (!result.ok) {
      // The claim stays used: a model that keeps failing validation must not loop for free.
      log(`ai-insights: rejected model output (${result.reason})`);
      return fallback('invalid_output');
    }

    try {
      await deps.store(userId, request, result.value, deps.model);
    } catch (e) {
      log(`ai-insights: store failed: ${message(e)}`);
    }
    return json(200, {
      status: 'ok',
      explanation: result.value,
      model: deps.model,
      cached: false,
    } satisfies AiResponse);
  };
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
