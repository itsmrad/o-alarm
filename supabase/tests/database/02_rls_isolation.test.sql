-- Two users: each only ever sees and writes their own rows.
begin;
select plan(28);

-- Fixtures as the table owner (bypasses RLS).
insert into public.users (id) values ('user_a'), ('user_b');
insert into public.devices (id, user_id, device_id, platform) values
  ('d0000000-0000-0000-0000-00000000000a', 'user_a', 'd0000000-0000-0000-0000-00000000000a', 'ios'),
  ('d0000000-0000-0000-0000-00000000000b', 'user_b', 'd0000000-0000-0000-0000-00000000000b', 'android');
insert into public.alarms (id, user_id, device_id, hour, minute) values
  ('a0000000-0000-0000-0000-00000000000a', 'user_a', 'd0000000-0000-0000-0000-00000000000a', 7, 0),
  ('a0000000-0000-0000-0000-00000000000b', 'user_b', 'd0000000-0000-0000-0000-00000000000b', 6, 30);
insert into public.alarm_occurrences (id, user_id, device_id, alarm_id, occurrence_key, local_date, expected_at) values
  ('0c000000-0000-0000-0000-00000000000a', 'user_a', 'd0000000-0000-0000-0000-00000000000a', 'a0000000-0000-0000-0000-00000000000a', 'k1', '2026-10-05', '2026-10-05 07:00+00'),
  ('0c000000-0000-0000-0000-00000000000b', 'user_b', 'd0000000-0000-0000-0000-00000000000b', 'a0000000-0000-0000-0000-00000000000b', 'k1', '2026-10-05', '2026-10-05 06:30+00');
insert into public.wake_sessions (id, user_id, device_id, alarm_occurrence_id, started_at) values
  ('e0000000-0000-0000-0000-00000000000a', 'user_a', 'd0000000-0000-0000-0000-00000000000a', '0c000000-0000-0000-0000-00000000000a', '2026-10-05 07:00+00'),
  ('e0000000-0000-0000-0000-00000000000b', 'user_b', 'd0000000-0000-0000-0000-00000000000b', '0c000000-0000-0000-0000-00000000000b', '2026-10-05 06:30+00');
insert into public.mission_attempts (id, user_id, device_id, wake_session_id, mission_type, started_at) values
  ('f0000000-0000-0000-0000-00000000000a', 'user_a', 'd0000000-0000-0000-0000-00000000000a', 'e0000000-0000-0000-0000-00000000000a', 'math', '2026-10-05 07:01+00'),
  ('f0000000-0000-0000-0000-00000000000b', 'user_b', 'd0000000-0000-0000-0000-00000000000b', 'e0000000-0000-0000-0000-00000000000b', 'shake', '2026-10-05 06:31+00');
insert into public.wake_checks (id, user_id, device_id, wake_session_id, method, due_at) values
  ('b0000000-0000-0000-0000-00000000000a', 'user_a', 'd0000000-0000-0000-0000-00000000000a', 'e0000000-0000-0000-0000-00000000000a', 'confirm', '2026-10-05 07:10+00'),
  ('b0000000-0000-0000-0000-00000000000b', 'user_b', 'd0000000-0000-0000-0000-00000000000b', 'e0000000-0000-0000-0000-00000000000b', 'confirm', '2026-10-05 06:40+00');
insert into public.sleep_sessions (id, user_id, device_id, started_at, ended_at, local_date) values
  ('51000000-0000-0000-0000-00000000000a', 'user_a', 'd0000000-0000-0000-0000-00000000000a', '2026-10-04 23:00+00', '2026-10-05 07:00+00', '2026-10-05'),
  ('51000000-0000-0000-0000-00000000000b', 'user_b', 'd0000000-0000-0000-0000-00000000000b', '2026-10-04 23:00+00', '2026-10-05 06:30+00', '2026-10-05');
insert into public.morning_checkins (id, user_id, device_id, local_date, energy, sleep_quality) values
  ('c1000000-0000-0000-0000-00000000000a', 'user_a', 'd0000000-0000-0000-0000-00000000000a', '2026-10-05', 4, 4),
  ('c1000000-0000-0000-0000-00000000000b', 'user_b', 'd0000000-0000-0000-0000-00000000000b', '2026-10-05', 2, 3);
insert into public.preferences (id, user_id, device_id) values
  ('90000000-0000-0000-0000-00000000000a', 'user_a', 'd0000000-0000-0000-0000-00000000000a'),
  ('90000000-0000-0000-0000-00000000000b', 'user_b', 'd0000000-0000-0000-0000-00000000000b');
insert into public.sync_state (id, user_id, device_id) values
  ('55000000-0000-0000-0000-00000000000a', 'user_a', 'd0000000-0000-0000-0000-00000000000a'),
  ('55000000-0000-0000-0000-00000000000b', 'user_b', 'd0000000-0000-0000-0000-00000000000b');
insert into public.ai_insights (user_id, type, period_start, period_end, structured) values
  ('user_a', 'weekly_report', '2026-09-28', '2026-10-04', '{}'),
  ('user_b', 'weekly_report', '2026-09-28', '2026-10-04', '{}');
insert into public.entitlements (user_id, is_active) values ('user_a', true), ('user_b', false);
insert into public.data_export_requests (user_id) values ('user_a'), ('user_b');
insert into public.events (id, user_id, device_id, name, occurred_at) values
  ('e7000000-0000-0000-0000-00000000000a', 'user_a', 'd0000000-0000-0000-0000-00000000000a', 'alarm_created', now()),
  ('e7000000-0000-0000-0000-00000000000b', 'user_b', 'd0000000-0000-0000-0000-00000000000b', 'alarm_created', now());

-- Act as user_a.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"user_a","role":"authenticated"}', true);

-- Every user-owned table: user_a sees exactly 1 row (their own), never user_b's.
select is(
  (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from public.%I', t), false, true, '')))[1]::text,
  '1', t || ': user_a sees only their own row')
from unnest(array[
  'devices', 'alarms', 'alarm_occurrences', 'wake_sessions', 'mission_attempts', 'wake_checks',
  'sleep_sessions', 'morning_checkins', 'preferences', 'sync_state', 'ai_insights', 'entitlements',
  'data_export_requests', 'events', 'users']) as t;                                  -- 15

select is((select count(*)::int from public.alarms where user_id = 'user_b'), 0, 'cannot select another user''s alarms by filter');
select ok((select count(*) >= 10 from public.missions), 'mission catalog is readable by signed-in users');

-- Writes against user_b's rows are silently filtered (update/delete) or rejected (insert).
select is_empty($$update public.alarms set label = 'pwned' where user_id = 'user_b' returning 1$$,
  'update of another user''s alarm touches 0 rows');
select throws_ok($$insert into public.alarms (id, user_id, device_id, hour, minute)
  values ('a0000000-0000-0000-0000-0000000000cc', 'user_b', 'd0000000-0000-0000-0000-00000000000a', 8, 0)$$,
  '42501', null, 'cannot insert a row owned by another user');
select throws_ok($$update public.alarms set user_id = 'user_b' where id = 'a0000000-0000-0000-0000-00000000000a'$$,
  '23514', null, 'cannot reassign a row to another user (user_id immutable)');
select throws_ok($$insert into public.users (id) values ('user_b')$$, '42501', null, 'cannot create the other user''s users row');
select throws_ok($$delete from public.alarms$$, '42501', null, 'clients cannot hard-delete (soft delete only)');

-- Own writes work, including soft delete.
select lives_ok($$insert into public.alarms (id, user_id, device_id, hour, minute)
  values ('a0000000-0000-0000-0000-0000000000a2', 'user_a', 'd0000000-0000-0000-0000-00000000000a', 8, 15)$$,
  'user_a can insert their own alarm');
select lives_ok($$update public.alarms set deleted_at = now() where id = 'a0000000-0000-0000-0000-0000000000a2'$$,
  'user_a can soft-delete their own alarm');

-- Cross-user parent reference is rejected structurally, even though user_a owns the child row.
select throws_ok($$insert into public.alarm_occurrences (id, user_id, device_id, alarm_id, occurrence_key, local_date, expected_at)
  values ('0c000000-0000-0000-0000-0000000000cc', 'user_a', 'd0000000-0000-0000-0000-00000000000a',
          'a0000000-0000-0000-0000-00000000000b', 'x', '2026-10-06', '2026-10-06 07:00+00');
  set constraints all immediate$$,
  '23503', null, 'occurrence cannot reference another user''s alarm');

-- Switch to user_b: symmetrical view, and user_a's soft-deleted alarm is invisible.
select set_config('request.jwt.claims', '{"sub":"user_b","role":"authenticated"}', true);
select is((select count(*)::int from public.alarms), 1, 'user_b sees only their own alarm');
select is((select label from public.alarms), '', 'user_b alarm unchanged by user_a''s update attempt');

-- A JWT without a sub sees nothing.
select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
select is((select count(*)::int from public.alarms), 0, 'authenticated JWT without sub sees no rows');

select * from finish();
rollback;
