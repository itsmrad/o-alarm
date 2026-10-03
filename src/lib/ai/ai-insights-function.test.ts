/** @jest-environment node */
import {
  aiRequestSchema,
  createAiInsightsHandler,
  createOpenRouterCompleter,
  DEFAULT_OPENROUTER_MODEL,
  OPENROUTER_URL,
  RATE_LIMITS,
  validateExplanation,
  type AiInsightsDeps,
  type AiRequest,
} from '../../../supabase/functions/ai-insights/core';

const REQUEST: AiRequest = {
  schemaVersion: 1,
  kind: 'weekly_report',
  period: { start: '2026-10-05', end: '2026-10-11' },
  week: {
    start: '2026-10-05',
    end: '2026-10-11',
    mornings: 5,
    successRate: 0.8,
    avgSnoozes: 1.2,
    medianDismissalMin: 6,
    missed: 0,
    retriggerMornings: 1,
    wakeChecksPassed: 4,
    wakeChecksFailed: 1,
    wakeCheckPassRate: 0.8,
    sleepNights: 5,
    avgSleepMin: 410,
    sleepConsistency: 64,
    avgEnergy: 3.4,
    checkIns: 5,
  },
  insights: [
    {
      id: 'snoozing',
      kind: 'snoozing',
      tone: 'neutral',
      confidence: 'medium',
      sampleSize: 12,
      metrics: { avgSnoozes: 1.2 },
    },
    {
      id: 'difficult_weekday:1',
      kind: 'difficult_weekday',
      tone: 'attention',
      confidence: 'low',
      sampleSize: 4,
      metrics: { weekdaySuccessRate: 0.25, overallSuccessRate: 0.8 },
      weekday: 'Monday',
    },
  ],
  bedtime: null,
};

const GOOD = {
  headline: 'A steady week with Mondays a little harder',
  summary:
    'You were up on time on 4 of 5 mornings. Mondays have been harder so far, though that is based on only a few mornings.',
  suggestions: [
    { text: 'You could try a short mission on your Monday alarm.', basedOn: 'difficult_weekday:1' },
  ],
};

describe('validateExplanation', () => {
  const check = (output: unknown, request: AiRequest = REQUEST) =>
    validateExplanation(output, request);

  it('accepts grounded, calm JSON (string or object)', () => {
    expect(check(JSON.stringify(GOOD))).toEqual({ ok: true, value: GOOD });
    expect(check(GOOD).ok).toBe(true);
  });

  it('rejects malformed output', () => {
    expect(check('not json')).toEqual({ ok: false, reason: 'not_json' });
    expect(check({ headline: 'x' })).toEqual({ ok: false, reason: 'schema' });
    expect(check({ ...GOOD, headline: '' })).toEqual({ ok: false, reason: 'schema' });
    expect(check({ ...GOOD, summary: 'x'.repeat(701) })).toEqual({ ok: false, reason: 'schema' });
    expect(
      check({
        ...GOOD,
        suggestions: [...GOOD.suggestions, ...GOOD.suggestions, ...GOOD.suggestions],
      }),
    ).toEqual({
      ok: false,
      reason: 'schema',
    });
  });

  it('rejects any action field (the AI can only suggest, never change alarms)', () => {
    expect(check({ ...GOOD, action: { type: 'update_alarm', hour: 6 } }).ok).toBe(false);
    expect(
      check({
        ...GOOD,
        suggestions: [{ ...GOOD.suggestions[0], action: 'set_alarm', alarmId: 'a1' }],
      }).ok,
    ).toBe(false);
  });

  it.each([
    ["I've moved your Monday alarm to 6:45.", 'alarm_change_claim'],
    ['We will update your alarm tonight.', 'alarm_change_claim'],
    ['O-Alarm has adjusted the alarm for you.', 'alarm_change_claim'],
    ['We will automatically shorten your snooze.', 'alarm_change_claim'],
    ['Short sleep causes your low energy.', 'causal_language'],
    ['Low energy is due to late bedtimes.', 'causal_language'],
    ['Snoozing leads to grogginess.', 'causal_language'],
    ['This may be insomnia.', 'medical_language'],
    ['Consider melatonin before bed.', 'medical_language'],
    ['See https://example.com for more.', 'markup'],
  ])('rejects unsafe text: %s', (text, reason) => {
    expect(check({ ...GOOD, summary: text })).toEqual({ ok: false, reason });
    expect(check({ ...GOOD, suggestions: [{ text, basedOn: 'snoozing' }] })).toEqual({
      ok: false,
      reason,
    });
  });

  it('allows suggestions that leave the change to the user', () => {
    const value = {
      ...GOOD,
      suggestions: [
        {
          text: 'You could try setting your Monday alarm a little earlier.',
          basedOn: 'difficult_weekday:1',
        },
      ],
    };
    expect(check(value).ok).toBe(true);
  });

  it('requires suggestions to rest on a given finding', () => {
    expect(check({ ...GOOD, suggestions: [{ text: 'Try a walk.', basedOn: 'made_up' }] })).toEqual({
      ok: false,
      reason: 'ungrounded_suggestion',
    });
    expect(check({ ...GOOD, suggestions: [{ text: 'Keep it up.', basedOn: 'week' }] }).ok).toBe(
      true,
    );
  });

  it('requires 1-2 suggestions in a weekly report with findings', () => {
    expect(check({ ...GOOD, suggestions: [] })).toEqual({
      ok: false,
      reason: 'missing_suggestion',
    });
    expect(check({ ...GOOD, suggestions: [] }, { ...REQUEST, insights: [] }).ok).toBe(true);
  });
});

describe('request schema (what the server accepts)', () => {
  it('accepts the aggregate payload', () => {
    expect(aiRequestSchema.safeParse(REQUEST).success).toBe(true);
  });

  it.each([
    ['an alarm label', { ...REQUEST, label: 'Gym' }],
    ['raw events', { ...REQUEST, events: [{ type: 'alarm_snoozed' }] }],
    [
      'an unknown insight field',
      { ...REQUEST, insights: [{ ...REQUEST.insights[0], alarmId: 'a1' }] },
    ],
    [
      'a free-text weekday',
      { ...REQUEST, insights: [{ ...REQUEST.insights[1], weekday: 'Gym day' }] },
    ],
    [
      'a free-text mission',
      { ...REQUEST, insights: [{ ...REQUEST.insights[0], chain: ['Call mom'] }] },
    ],
    [
      'a timestamp finer than a day',
      { ...REQUEST, period: { start: '2026-10-05T07:00:00Z', end: '2026-10-11' } },
    ],
    [
      'a timestamp in the week',
      { ...REQUEST, week: { ...REQUEST.week, end: '2026-10-11T06:59:00.000Z' } },
    ],
    [
      'a free-text metric key',
      { ...REQUEST, insights: [{ ...REQUEST.insights[0], metrics: { 'my note': 1 } }] },
    ],
    [
      'a string metric',
      { ...REQUEST, insights: [{ ...REQUEST.insights[0], metrics: { avgSnoozes: '1' } }] },
    ],
  ])('rejects %s', (_label, body) => {
    expect(aiRequestSchema.safeParse(body).success).toBe(false);
  });
});

// ------------------------------------------------------------------------------- handler

function setup(over: Partial<AiInsightsDeps> = {}) {
  const deps = {
    verifyCaller: jest.fn(async (token: string) => (token === 'good' ? 'user_1' : null)),
    isPro: jest.fn(async () => true),
    findStored: jest.fn(async () => null),
    claimQuota: jest.fn(async () => 'claim-1' as string | null),
    releaseQuota: jest.fn(async () => undefined),
    complete: jest.fn(async () => JSON.stringify(GOOD)),
    store: jest.fn(async () => undefined),
    model: 'anthropic/test',
    timeoutMs: 50,
    ...over,
  } satisfies AiInsightsDeps;
  const call = (
    body: unknown = REQUEST,
    headers: Record<string, string> = { authorization: 'Bearer good' },
  ) =>
    createAiInsightsHandler(deps)(
      new Request('https://x.test/ai-insights', {
        method: 'POST',
        headers,
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
    );
  return { deps, call };
}

describe('ai-insights handler', () => {
  it('verifies the caller from the token, never the body', async () => {
    const { deps, call } = setup();
    expect((await call(REQUEST, {})).status).toBe(401);
    expect((await call(REQUEST, { authorization: 'Bearer bad' })).status).toBe(401);
    expect(deps.complete).not.toHaveBeenCalled();
    const { call: failing } = setup({
      verifyCaller: jest.fn().mockRejectedValue(new Error('down')),
    });
    expect((await failing()).status).toBe(401);
  });

  it('rejects payloads outside the strict schema before anything else runs', async () => {
    const { deps, call } = setup();
    expect((await call('{oops')).status).toBe(400);
    expect((await call({ ...REQUEST, notes: 'free text' })).status).toBe(400);
    expect(deps.isPro).not.toHaveBeenCalled();
  });

  it('is Pro only', async () => {
    const { deps, call } = setup({ isPro: jest.fn(async () => false) });
    const response = await call();
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'pro_required' });
    expect(deps.claimQuota).not.toHaveBeenCalled();
  });

  it('rate-limits per bucket: 1 weekly report and 10 explanations', async () => {
    const { deps, call } = setup({ claimQuota: jest.fn(async () => null) });
    const response = await call();
    expect(response.status).toBe(429);
    expect(deps.claimQuota).toHaveBeenCalledWith(
      'user_1',
      'weekly_report',
      RATE_LIMITS.weekly_report,
    );
    expect(deps.complete).not.toHaveBeenCalled();
    await call({ ...REQUEST, kind: 'explain', topic: 'wake_pattern', week: undefined });
    expect(deps.claimQuota).toHaveBeenLastCalledWith('user_1', 'explanation', 10);
  });

  it('returns a validated explanation and stores it for the verified user', async () => {
    const { deps, call } = setup();
    const response = await call();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'ok',
      explanation: GOOD,
      model: 'anthropic/test',
      cached: false,
    });
    expect(deps.complete).toHaveBeenCalledWith(REQUEST, expect.any(AbortSignal));
    expect(deps.store).toHaveBeenCalledWith('user_1', REQUEST, GOOD, 'anthropic/test');
  });

  it("reuses this week's stored report without spending quota", async () => {
    const { deps, call } = setup({
      findStored: jest.fn(async () => ({
        request: REQUEST,
        explanation: GOOD,
        model: 'anthropic/old',
      })),
    });
    expect(await (await call()).json()).toEqual({
      status: 'ok',
      explanation: GOOD,
      model: 'anthropic/old',
      cached: true,
    });
    expect(deps.claimQuota).not.toHaveBeenCalled();
  });

  it('re-explains a topic when its numbers changed', async () => {
    const explain = { ...REQUEST, kind: 'explain', topic: 'wake_pattern' } as Record<
      string,
      unknown
    >;
    delete explain.week;
    const { deps, call } = setup({
      findStored: jest.fn(async () => ({
        request: { ...explain, insights: [] },
        explanation: GOOD,
        model: 'm',
      })),
    });
    await call(explain);
    expect(deps.complete).toHaveBeenCalled();
  });

  it('falls back to deterministic insights when the model is not configured', async () => {
    const { deps, call } = setup({ complete: null });
    expect(await (await call()).json()).toEqual({ status: 'fallback', reason: 'not_configured' });
    expect(deps.claimQuota).not.toHaveBeenCalled();
  });

  it('falls back on an upstream failure and gives the quota back', async () => {
    const { deps, call } = setup({
      complete: jest.fn().mockRejectedValue(new Error('OpenRouter 503')),
    });
    expect(await (await call()).json()).toEqual({ status: 'fallback', reason: 'unavailable' });
    expect(deps.releaseQuota).toHaveBeenCalledWith('claim-1');
    expect(deps.store).not.toHaveBeenCalled();
  });

  it('falls back on a timeout and aborts the request', async () => {
    let aborted = false;
    const { deps, call } = setup({
      complete: jest.fn(
        (_request: AiRequest, signal: AbortSignal) =>
          new Promise<string>(() => {
            signal.addEventListener('abort', () => (aborted = true));
          }),
      ),
    });
    expect(await (await call()).json()).toEqual({ status: 'fallback', reason: 'unavailable' });
    expect(aborted).toBe(true);
    expect(deps.releaseQuota).toHaveBeenCalled();
  });

  it('never returns unsafe model output', async () => {
    const { deps, call } = setup({
      complete: jest.fn(async () =>
        JSON.stringify({ ...GOOD, summary: 'I have moved your alarm earlier.' }),
      ),
    });
    expect(await (await call()).json()).toEqual({ status: 'fallback', reason: 'invalid_output' });
    expect(deps.store).not.toHaveBeenCalled();
    expect(deps.releaseQuota).not.toHaveBeenCalled();
  });

  it('still answers when storing fails', async () => {
    const { call } = setup({ store: jest.fn().mockRejectedValue(new Error('db down')) });
    expect((await (await call()).json()).status).toBe('ok');
  });
});

describe('OpenRouter completer (mocked)', () => {
  const mockFetch = (body: unknown, status = 200) =>
    jest.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify(body), { status }),
    );

  it('sends only the structured payload with a strict JSON schema, server-side key', async () => {
    const fetchMock = mockFetch({ choices: [{ message: { content: JSON.stringify(GOOD) } }] });
    const complete = createOpenRouterCompleter({
      apiKey: 'sk-or-test',
      model: DEFAULT_OPENROUTER_MODEL,
      fetch: fetchMock,
    });
    expect(await complete(REQUEST, new AbortController().signal)).toBe(JSON.stringify(GOOD));

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(OPENROUTER_URL);
    expect((init!.headers as Record<string, string>).authorization).toBe('Bearer sk-or-test');
    const body = JSON.parse(init!.body as string);
    expect(body.model).toBe('anthropic/claude-sonnet-5.5');
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(body.provider).toEqual({ data_collection: 'deny', require_parameters: true });
    expect(body.messages).toHaveLength(2);
    expect(body.messages[1].content).toContain(JSON.stringify(REQUEST));
    expect(body.messages[0].content).toMatch(/never causes|Describe associations, never causes/);
  });

  it('throws on HTTP errors and empty completions', async () => {
    const signal = new AbortController().signal;
    await expect(
      createOpenRouterCompleter({ apiKey: 'k', model: 'm', fetch: mockFetch({ error: 'x' }, 502) })(
        REQUEST,
        signal,
      ),
    ).rejects.toThrow('OpenRouter 502');
    await expect(
      createOpenRouterCompleter({ apiKey: 'k', model: 'm', fetch: mockFetch({ choices: [] }) })(
        REQUEST,
        signal,
      ),
    ).rejects.toThrow('empty completion');
  });
});
