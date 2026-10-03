-- D22 server-side Pro gating of sync writes, the one-time guest migration window, and the
-- D25/D26 schema gaps closed by 20261003000001_account_sync.sql.
begin;
select plan(44);

-- Fixtures as the table owner (bypasses RLS).
--   pro_user:     active pro entitlement
--   free_user:    no entitlement
--   lapsed_user:  had pro (expired), owns an alarm
--   migrant:      free, will use the guest migration window
insert into public.users (id) values ('pro_user'), ('free_user'), ('lapsed_user'), ('migrant'), ('stale_migrant');
insert into public.entitlements (user_id, is_active, expires_at) values
  ('pro_user', true, now() + interval '30 days'),
  ('lapsed_user', true, now() - interval '1 day');
insert into public.entitlements (user_id, entitlement, is_active) values ('free_user', 'something_else', true);
insert into public.alarms (id, user_id, device_id, hour, minute) values
  ('a1000000-0000-0000-0000-00000000000c', 'lapsed_user', 'd1000000-0000-0000-0000-00000000000c', 7, 0);
insert into public.guest_migrations (user_id, device_id, started_at) values
  ('stale_migrant', 'd1000000-0000-0000-0000-00000000000e', now() - interval '8 days');

-- Helpers are not callable by anon.
select ok(not has_function_privilege('anon', 'public.has_entitlement(text)', 'execute'), 'anon cannot call has_entitlement');
select ok(not has_function_privilege('anon', 'public.begin_guest_migration(uuid)', 'execute'), 'anon cannot call begin_guest_migration');
select ok(not has_function_privilege('authenticated', 'public.guest_migration_open()', 'execute'), 'guest_migration_open is internal');
select ok(has_table_privilege('authenticated', 'public.guest_migrations', 'select')
  and not has_table_privilege('authenticated', 'public.guest_migrations', 'insert')
  and not has_table_privilege('authenticated', 'public.guest_migrations', 'update'),
  'clients can only read guest_migrations');
select ok('guest_migrations' = any(public.user_data_tables()), 'guest_migrations is covered by export/delete');

set local role authenticated;

-- ---------------------------------------------------------------- pro user
select set_config('request.jwt.claims', '{"sub":"pro_user","role":"authenticated"}', true);
select ok(public.has_entitlement('pro'), 'pro_user has pro');
select ok(not public.has_entitlement('ultra'), 'pro_user lacks an unknown entitlement');
select lives_ok($$insert into public.alarms (id, user_id, device_id, hour, minute, important,
    gradual_volume_ramp_seconds, wake_check_enabled, wake_check_delay_minutes, wake_check_response_window_seconds,
    wake_check_max_retriggers, wake_check_method, wake_check_mission_id, snooze_limit, sound, label)
  values ('a1000000-0000-0000-0000-00000000000a', 'pro_user', 'd1000000-0000-0000-0000-00000000000a', 6, 45, true,
    120, true, 45, 300, 10, 'mission', 'math', 10, 'custom:rooster.caf', repeat('x', 60))$$,
  'pro user can insert an alarm using every new column at its local bounds');
select lives_ok($$update public.alarms set deleted_at = now() where id = 'a1000000-0000-0000-0000-00000000000a'$$,
  'pro user can soft-delete (tombstone)');
select lives_ok($$insert into public.devices (id, user_id, device_id, platform) values
  ('d1000000-0000-0000-0000-00000000000a', 'pro_user', 'd1000000-0000-0000-0000-00000000000a', 'ios')$$,
  'pro user can register a device');
select lives_ok($$insert into public.events (id, user_id, device_id, name, occurred_at)
  values (gen_random_uuid(), 'pro_user', 'd1000000-0000-0000-0000-00000000000a', 'alarm_deleted', now())$$,
  'alarm_deleted is an accepted event name (D26)');
select lives_ok($$insert into public.sync_state (id, user_id, device_id, pull_cursor) values
  (gen_random_uuid(), 'pro_user', 'd1000000-0000-0000-0000-00000000000a', now())$$, 'pro user can write sync_state');

-- ---------------------------------------------------------------- free user
select set_config('request.jwt.claims', '{"sub":"free_user","role":"authenticated"}', true);
select ok(not public.has_entitlement('pro'), 'free_user has no pro (other entitlements do not count)');
select ok(not public.can_write_sync(), 'free_user cannot write sync tables');
select throws_ok($$insert into public.alarms (id, user_id, device_id, hour, minute)
  values (gen_random_uuid(), 'free_user', gen_random_uuid(), 7, 0)$$, '42501', null, 'free user cannot insert alarms');
select throws_ok($$insert into public.events (id, user_id, device_id, name, occurred_at)
  values (gen_random_uuid(), 'free_user', gen_random_uuid(), 'alarm_created', now())$$, '42501', null, 'free user cannot insert events');
select throws_ok($$insert into public.devices (id, user_id, device_id, platform)
  values (gen_random_uuid(), 'free_user', gen_random_uuid(), 'android')$$, '42501', null, 'free user cannot register a sync device');
select lives_ok($$insert into public.users (id) values ('free_user') on conflict (id) do update set timezone = 'Europe/Berlin'$$,
  'free user can upsert their own account row');
select lives_ok($$insert into public.data_export_requests (user_id) values ('free_user')$$,
  'free user can request an export');
select lives_ok($$select public.export_my_data()$$, 'free user can export');

-- ---------------------------------------------------------------- lapsed subscriber
select set_config('request.jwt.claims', '{"sub":"lapsed_user","role":"authenticated"}', true);
select ok(not public.has_entitlement('pro'), 'an expired entitlement is not pro');
select is((select count(*)::int from public.alarms), 1, 'lapsed user still reads their alarms');
select throws_ok($$update public.alarms set label = 'edit' where id = 'a1000000-0000-0000-0000-00000000000c'$$,
  '42501', null, 'lapsed user cannot update synced rows');
select is((public.export_my_data()->'tables'->'alarms'->0->>'id'), 'a1000000-0000-0000-0000-00000000000c',
  'lapsed user exports their alarms');
select is((public.delete_my_data()->>'alarms')::int, 1, 'lapsed user can delete their data');

-- ---------------------------------------------------------------- guest -> account migration
select set_config('request.jwt.claims', '{"sub":"migrant","role":"authenticated"}', true);
select ok(not public.can_write_sync(), 'migrant cannot write before starting the migration');
select is((public.begin_guest_migration('d1000000-0000-0000-0000-00000000000d')->>'open')::boolean, true,
  'begin_guest_migration opens the window');
select is((public.begin_guest_migration('d1000000-0000-0000-0000-00000000000d')->>'open')::boolean, true,
  'begin_guest_migration is idempotent while open (resumable)');
select lives_ok($$insert into public.alarms (id, user_id, device_id, hour, minute)
  values ('a1000000-0000-0000-0000-00000000000d', 'migrant', 'd1000000-0000-0000-0000-00000000000d', 6, 0)$$,
  'free user can upload during the migration window');
select lives_ok($$insert into public.events (id, user_id, device_id, name, occurred_at)
  values (gen_random_uuid(), 'migrant', 'd1000000-0000-0000-0000-00000000000d', 'alarm_created', now())$$,
  'free user can upload history during the migration window');
select is((select count(*)::int from public.guest_migrations), 1, 'migrant reads their migration row');
select is((public.complete_guest_migration()->>'open')::boolean, false, 'complete_guest_migration closes the window');
select throws_ok($$insert into public.alarms (id, user_id, device_id, hour, minute)
  values (gen_random_uuid(), 'migrant', gen_random_uuid(), 7, 0)$$, '42501', null, 'free user cannot write after the migration');
select is((public.begin_guest_migration('d1000000-0000-0000-0000-00000000000f')->>'open')::boolean, false,
  'the migration happens once per account (a later device cannot reopen it)');
select is((select completed_at is not null from public.guest_migrations), true, 'completion is recorded');

select set_config('request.jwt.claims', '{"sub":"stale_migrant","role":"authenticated"}', true);
select is((public.begin_guest_migration('d1000000-0000-0000-0000-00000000000e')->>'open')::boolean, false,
  'a migration window expires after guest_migration_window()');

-- Unauthenticated callers.
select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
select throws_ok($$select public.begin_guest_migration(gen_random_uuid())$$, '28000', null, 'begin_guest_migration needs a sub');
select ok(not public.has_entitlement('pro'), 'no sub, no entitlement');

-- ---------------------------------------------------------------- D25 constraints (as owner)
reset role;
select throws_ok($$insert into public.alarms (id, user_id, device_id, hour, minute, label)
  values (gen_random_uuid(), 'pro_user', gen_random_uuid(), 7, 0, repeat('x', 61))$$, '23514', null, 'label is at most 60 chars');
select throws_ok($$insert into public.alarms (id, user_id, device_id, hour, minute, snooze_limit)
  values (gen_random_uuid(), 'pro_user', gen_random_uuid(), 7, 0, 11)$$, '23514', null, 'snooze_limit is at most 10');
select throws_ok($$insert into public.alarms (id, user_id, device_id, hour, minute, snooze_limit)
  values (gen_random_uuid(), 'pro_user', gen_random_uuid(), 7, 0, null)$$, '23502', null, 'snooze_limit is never unlimited');
select throws_ok($$insert into public.alarms (id, user_id, device_id, hour, minute, wake_check_response_window_seconds)
  values (gen_random_uuid(), 'pro_user', gen_random_uuid(), 7, 0, 10)$$, '23514', null, 'response window is at least 15 s');
select throws_ok($$insert into public.alarms (id, user_id, device_id, hour, minute, wake_check_method)
  values (gen_random_uuid(), 'pro_user', gen_random_uuid(), 7, 0, 'mission')$$, '23514', null, 'mission wake check needs a mission id');
select throws_ok($$insert into public.alarms (id, user_id, device_id, hour, minute, sound)
  values (gen_random_uuid(), 'pro_user', gen_random_uuid(), 7, 0, 'bogus')$$, '23514', null, 'sound must use the kind:id encoding');

select * from finish();
rollback;
