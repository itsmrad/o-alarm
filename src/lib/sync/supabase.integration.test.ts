/**
 * @jest-environment node
 *
 * (Node env: jest-expo stubs `fetch`; this test needs real HTTP.)
 *
 * End-to-end sync against a LOCAL Supabase stack (real PostgREST + RLS + D22 gating).
 * Skipped unless SUPABASE_IT_URL is set, so `npm test` never needs Docker. Run with:
 *
 *   npx supabase@latest start && npx supabase@latest db reset
 *   SUPABASE_IT_URL=http://127.0.0.1:54321 SUPABASE_IT_KEY=<publishable key> \
 *   SUPABASE_IT_JWT_SECRET=<JWT_SECRET from `supabase status -o env`> \
 *     npx jest src/lib/sync/supabase.integration.test.ts
 *   npx supabase@latest stop
 *
 * Clerk is simulated with locally signed HS256 JWTs (sub = Clerk user id, role = authenticated),
 * which is exactly what the Clerk third-party-auth integration hands PostgREST.
 */
import { createClient } from '@supabase/supabase-js';
import { createHmac, randomUUID } from 'node:crypto';
import { request } from 'node:http';

import { createAlarmService } from '@/db/alarm-service';
import { createTestDatabase } from '@/db/testing/test-db';
import { createAlarm } from '@/domain';
import { FakeAlarmEngine } from '@/engine/testing/fake-engine';
import type { Tier } from '@/lib/entitlements';
import { createSupabaseClient } from '@/lib/supabase';

import { createSyncEngine } from './engine';
import { createSupabaseTransport } from './supabase-transport';

const URL = process.env.SUPABASE_IT_URL;
const KEY = process.env.SUPABASE_IT_KEY ?? '';
const SECRET = process.env.SUPABASE_IT_JWT_SECRET ?? '';
const NY = 'America/New_York';

/**
 * jest-expo replaces `fetch` with a stub even in the node environment, so this test brings a
 * minimal real one (node:http) with just what postgrest-js reads from a Response.
 */
const nodeFetch = ((input: string | URL, init: RequestInit = {}) =>
  new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    const raw = init.headers as
      | { forEach?: (cb: (v: string, k: string) => void) => void }
      | Record<string, string>
      | undefined;
    if (raw && typeof raw.forEach === 'function') raw.forEach((v, k) => (headers[k] = v));
    else Object.assign(headers, raw ?? {});
    const req = request(String(input), { method: init.method ?? 'GET', headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const status = res.statusCode ?? 0;
        resolve({
          ok: status >= 200 && status < 300,
          status,
          statusText: res.statusMessage ?? '',
          headers: { get: (name: string) => (res.headers[name.toLowerCase()] as string) ?? null },
          text: async () => text,
          json: async () => JSON.parse(text),
        });
      });
    });
    req.on('error', reject);
    if (init.body) req.write(init.body as string);
    req.end();
  })) as unknown as typeof fetch;

const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
function sign(payload: Record<string, unknown>): string {
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...payload,
  });
  const signature = createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${signature}`;
}

const admin = () =>
  createClient(URL!, KEY, {
    accessToken: async () => sign({ role: 'service_role' }),
    global: { fetch: nodeFetch },
  });

function device(userId: string, tier: () => Tier) {
  const { db, close } = createTestDatabase();
  const engine = new FakeAlarmEngine();
  const deviceId = randomUUID();
  const alarms = createAlarmService({ db, engine, deviceId, timeZone: () => NY });
  const token = sign({ sub: userId, role: 'authenticated', aud: 'authenticated' });
  const transport = createSupabaseTransport(
    createSupabaseClient({ url: URL!, publishableKey: KEY, fetch: nodeFetch }, async () => token),
  );
  const sync = createSyncEngine({
    db,
    transport,
    userId,
    deviceId,
    device: {
      platform: 'android',
      osVersion: '16',
      appVersion: '0.1.0',
      model: null,
      alarmEngine: 'native',
    },
    getTier: tier,
    reconcile: () => alarms.reconcileAll(),
    timeZone: () => NY,
  });
  return { db, alarms, sync, transport, engine, close };
}

const draft = (label: string) => {
  const { id: _id, ...alarm } = createAlarm({ id: 'x', hour: 6, minute: 15, weekdays: [1, 3, 5] });
  return { ...alarm, label };
};

(URL ? describe : describe.skip)('sync against local Supabase', () => {
  it('free account: migrates once, then the server rejects further writes (D22)', async () => {
    const userId = `user_it_free_${randomUUID()}`;
    const phone = device(userId, () => 'free');
    const { alarm } = await phone.alarms.save(draft('Guest alarm'));

    const first = await phone.sync.run();
    expect({ outcome: first.outcome, error: first.error?.message }).toEqual({
      outcome: 'not_entitled',
      error: undefined,
    });

    const { data: rows } = await admin().from('alarms').select('*').eq('user_id', userId);
    expect(rows).toEqual([
      expect.objectContaining({ id: alarm.id, label: 'Guest alarm', weekdays: [1, 3, 5] }),
    ]);
    const { data: migration } = await admin()
      .from('guest_migrations')
      .select('*')
      .eq('user_id', userId)
      .single();
    expect(migration?.completed_at).toEqual(expect.any(String));

    // A free client that tries anyway is stopped by RLS, classified as `forbidden`.
    await expect(
      phone.transport.upsert('alarms', [{ ...rows![0], label: 'Sneaky' }]),
    ).rejects.toMatchObject({ kind: 'forbidden' });

    // Export + delete stay available on the free tier.
    const exported = (await phone.transport.exportMyData()) as { tables: { alarms: unknown[] } };
    expect(exported.tables.alarms).toHaveLength(1);
    expect((await phone.transport.deleteMyData()).alarms).toBe(1);
    phone.close();
  });

  it('pro account: two devices converge (push, pull, LWW, tombstones) through the real schema', async () => {
    const userId = `user_it_pro_${randomUUID()}`;
    await admin().from('users').insert({ id: userId });
    await admin().from('entitlements').insert({ user_id: userId, is_active: true });

    const phone = device(userId, () => 'pro');
    const tablet = device(userId, () => 'pro');
    const { alarm } = await phone.alarms.save({
      ...draft('Gym'),
      wakeCheck: {
        enabled: true,
        delayMin: 45,
        responseWindowSec: 300,
        method: 'mission',
        missionId: 'math',
        maxRetriggers: 5,
      },
      important: true,
      sound: { kind: 'system', id: 'Radar' },
    });
    const first = await phone.sync.run();
    expect({ outcome: first.outcome, error: first.error?.message }).toEqual({
      outcome: 'synced',
      error: undefined,
    });

    const pulled = await tablet.sync.run();
    expect(pulled).toMatchObject({ outcome: 'synced', applied: 1 });
    expect(tablet.alarms.get(alarm.id)).toEqual(phone.alarms.get(alarm.id));
    expect(tablet.engine.entries.some((e) => e.alarmId === alarm.id)).toBe(true);

    await tablet.alarms.save({ ...tablet.alarms.get(alarm.id)!, label: 'Gym (tablet)' });
    await tablet.sync.run();
    await phone.sync.run();
    expect(phone.alarms.get(alarm.id)?.label).toBe('Gym (tablet)');

    await phone.alarms.remove(alarm.id);
    await phone.sync.run();
    await tablet.sync.run();
    expect(tablet.alarms.get(alarm.id)).toBeNull();
    expect(tablet.engine.entries.some((e) => e.alarmId === alarm.id)).toBe(false);

    const { data: history } = await admin().from('events').select('name').eq('user_id', userId);
    expect(history?.map((e) => e.name)).toEqual(
      expect.arrayContaining(['alarm_created', 'alarm_deleted']),
    );
    const { data: devices } = await admin().from('devices').select('id').eq('user_id', userId);
    expect(devices).toHaveLength(2);

    await phone.transport.deleteMyData();
    phone.close();
    tablet.close();
  });
});
