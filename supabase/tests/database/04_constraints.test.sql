-- Check / unique / FK constraints accept valid data and reject invalid data.
begin;
select plan(28);

insert into public.users (id) values ('user_a'), ('user_b');

-- alarms
select lives_ok($$insert into public.alarms (id, user_id, device_id, hour, minute, weekdays, mission_chain)
  values ('a0000000-0000-0000-0000-000000000001', 'user_a', 'd0000000-0000-0000-0000-00000000000a', 7, 0, '{1,2,3,4,5}', '[{"type":"math"}]')$$,
  'valid weekday alarm');
select lives_ok($$insert into public.alarms (id, user_id, device_id, hour, minute, one_time_date, timezone_policy, timezone)
  values ('a0000000-0000-0000-0000-000000000002', 'user_a', 'd0000000-0000-0000-0000-00000000000a', 23, 59, '2026-12-24', 'fixed', 'Asia/Kolkata')$$,
  'valid one-time fixed-timezone alarm');
select throws_ok($$insert into public.alarms (id, user_id, device_id, hour, minute) values (gen_random_uuid(), 'user_a', gen_random_uuid(), 24, 0)$$,
  '23514', null, 'hour 24 rejected');
select throws_ok($$insert into public.alarms (id, user_id, device_id, hour, minute) values (gen_random_uuid(), 'user_a', gen_random_uuid(), 7, 60)$$,
  '23514', null, 'minute 60 rejected');
select throws_ok($$insert into public.alarms (id, user_id, device_id, hour, minute, weekdays) values (gen_random_uuid(), 'user_a', gen_random_uuid(), 7, 0, '{0}')$$,
  '23514', null, 'weekday 0 rejected (ISO 1..7)');
select throws_ok($$insert into public.alarms (id, user_id, device_id, hour, minute, weekdays, one_time_date) values (gen_random_uuid(), 'user_a', gen_random_uuid(), 7, 0, '{1}', '2026-12-24')$$,
  '23514', null, 'alarm cannot be both recurring and one-time');
select throws_ok($$insert into public.alarms (id, user_id, device_id, hour, minute, timezone_policy) values (gen_random_uuid(), 'user_a', gen_random_uuid(), 7, 0, 'fixed')$$,
  '23514', null, 'fixed timezone policy needs a timezone');
select throws_ok($$insert into public.alarms (id, user_id, device_id, hour, minute, snooze_minutes) values (gen_random_uuid(), 'user_a', gen_random_uuid(), 7, 0, 0)$$,
  '23514', null, 'snooze_minutes 0 rejected');
select throws_ok($$insert into public.alarms (id, user_id, device_id, hour, minute, override_hour) values (gen_random_uuid(), 'user_a', gen_random_uuid(), 7, 0, 8)$$,
  '23514', null, 'partial one-off override rejected');
select throws_ok($$insert into public.alarms (id, user_id, device_id, hour, minute, mission_chain) values (gen_random_uuid(), 'user_a', gen_random_uuid(), 7, 0, '{"type":"math"}')$$,
  '23514', null, 'mission_chain must be an array');

-- occurrences
select lives_ok($$insert into public.alarm_occurrences (id, user_id, device_id, alarm_id, occurrence_key, local_date, expected_at, triggered_at, dismissed_at, outcome)
  values ('0c000000-0000-0000-0000-000000000001', 'user_a', 'd0000000-0000-0000-0000-00000000000a', 'a0000000-0000-0000-0000-000000000001', 'k1', '2026-10-05', '2026-10-05 07:00+00', '2026-10-05 07:00:01+00', '2026-10-05 07:01+00', 'dismissed')$$,
  'valid occurrence');
select throws_ok($$insert into public.alarm_occurrences (id, user_id, device_id, alarm_id, occurrence_key, local_date, expected_at)
  values (gen_random_uuid(), 'user_a', gen_random_uuid(), 'a0000000-0000-0000-0000-000000000001', 'k1', '2026-10-05', '2026-10-05 07:00+00')$$,
  '23505', null, 'duplicate (alarm, occurrence_key) rejected');
select throws_ok($$insert into public.alarm_occurrences (id, user_id, device_id, alarm_id, occurrence_key, local_date, expected_at, triggered_at, dismissed_at)
  values (gen_random_uuid(), 'user_a', gen_random_uuid(), 'a0000000-0000-0000-0000-000000000001', 'k2', '2026-10-06', '2026-10-06 07:00+00', '2026-10-06 07:05+00', '2026-10-06 07:00+00')$$,
  '23514', null, 'dismissed before triggered rejected');
select throws_ok($$insert into public.alarm_occurrences (id, user_id, device_id, alarm_id, occurrence_key, local_date, expected_at, outcome)
  values (gen_random_uuid(), 'user_a', gen_random_uuid(), 'a0000000-0000-0000-0000-000000000001', 'k3', '2026-10-07', '2026-10-07 07:00+00', 'dismissed')$$,
  '23514', null, 'outcome dismissed requires dismissed_at');
select throws_ok($$insert into public.alarm_occurrences (id, user_id, device_id, alarm_id, occurrence_key, local_date, expected_at, snooze_count)
  values (gen_random_uuid(), 'user_a', gen_random_uuid(), 'a0000000-0000-0000-0000-000000000001', 'k4', '2026-10-08', '2026-10-08 07:00+00', -1)$$,
  '23514', null, 'negative snooze_count rejected');
select throws_ok($$insert into public.alarm_occurrences (id, user_id, device_id, alarm_id, occurrence_key, local_date, expected_at)
  values (gen_random_uuid(), 'user_b', gen_random_uuid(), 'a0000000-0000-0000-0000-000000000001', 'k5', '2026-10-09', '2026-10-09 07:00+00');
  set constraints all immediate$$,
  '23503', null, 'occurrence of user_b cannot hang off user_a''s alarm');

-- wake flow
select lives_ok($$insert into public.wake_sessions (id, user_id, device_id, alarm_occurrence_id, started_at, ended_at, status)
  values ('e0000000-0000-0000-0000-000000000001', 'user_a', 'd0000000-0000-0000-0000-00000000000a', '0c000000-0000-0000-0000-000000000001', '2026-10-05 07:00+00', '2026-10-05 07:10+00', 'success')$$,
  'valid finished wake session');
select throws_ok($$insert into public.wake_sessions (id, user_id, device_id, alarm_occurrence_id, started_at, status)
  values (gen_random_uuid(), 'user_a', gen_random_uuid(), '0c000000-0000-0000-0000-000000000001', '2026-10-05 07:00+00', 'active')$$,
  '23505', null, 'one wake session per occurrence');
select throws_ok($$insert into public.mission_attempts (id, user_id, device_id, wake_session_id, mission_type, started_at)
  values (gen_random_uuid(), 'user_a', gen_random_uuid(), 'e0000000-0000-0000-0000-000000000001', 'teleport', '2026-10-05 07:01+00');
  set constraints all immediate$$,
  '23503', null, 'unknown mission type rejected by catalog FK');
select throws_ok($$insert into public.mission_attempts (id, user_id, device_id, wake_session_id, mission_type, started_at, outcome)
  values (gen_random_uuid(), 'user_a', gen_random_uuid(), 'e0000000-0000-0000-0000-000000000001', 'math', '2026-10-05 07:01+00', 'completed')$$,
  '23514', null, 'finished attempt requires ended_at');
select throws_ok($$insert into public.wake_checks (id, user_id, device_id, wake_session_id, method, due_at, outcome)
  values (gen_random_uuid(), 'user_a', gen_random_uuid(), 'e0000000-0000-0000-0000-000000000001', 'telepathy', '2026-10-05 07:15+00', 'pending')$$,
  '23514', null, 'unknown wake check method rejected');

-- sleep
select lives_ok($$insert into public.sleep_sessions (id, user_id, device_id, started_at, ended_at, local_date)
  values ('51000000-0000-0000-0000-000000000001', 'user_a', 'd0000000-0000-0000-0000-00000000000a', '2026-10-04 23:00+00', '2026-10-05 06:30+00', '2026-10-05')$$,
  'valid sleep session');
select is((select duration_minutes from public.sleep_sessions where id = '51000000-0000-0000-0000-000000000001'), 450,
  'sleep duration is computed (7h30m = 450 min)');
select throws_ok($$insert into public.sleep_sessions (id, user_id, device_id, started_at, ended_at, local_date)
  values (gen_random_uuid(), 'user_a', gen_random_uuid(), '2026-10-05 06:30+00', '2026-10-04 23:00+00', '2026-10-05')$$,
  '23514', null, 'sleep must end after it starts');

-- morning check-ins
select throws_ok($$insert into public.morning_checkins (id, user_id, device_id, local_date, energy, sleep_quality)
  values (gen_random_uuid(), 'user_a', gen_random_uuid(), '2026-10-05', 6, 3)$$, '23514', null, 'energy 6 rejected');
select throws_ok($$insert into public.morning_checkins (id, user_id, device_id, local_date, energy, sleep_quality)
  values (gen_random_uuid(), 'user_a', gen_random_uuid(), '2026-10-05', 3, 0)$$, '23514', null, 'sleep_quality 0 rejected');

-- events
select throws_ok($$insert into public.events (id, user_id, device_id, name, occurred_at)
  values (gen_random_uuid(), 'user_a', gen_random_uuid(), 'alarm_exploded', now())$$,
  '23514', null, 'unknown event name rejected');
select lives_ok($$insert into public.events (id, user_id, device_id, name, occurred_at)
  select gen_random_uuid(), 'user_a', gen_random_uuid(), n, now() from unnest(array[
    'alarm_created', 'alarm_updated', 'alarm_native_scheduled', 'alarm_schedule_failed',
    'alarm_expected', 'alarm_trigger_received', 'alarm_snoozed', 'alarm_dismissed',
    'mission_started', 'mission_completed', 'mission_failed',
    'wake_check_started', 'wake_check_passed', 'wake_check_failed', 'alarm_retriggered']) n$$,
  'all 15 PRODUCT.md key events are accepted');

select * from finish();
rollback;
