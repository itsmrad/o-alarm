-- Analytics views compute the documented numbers and stay scoped to the caller.
begin;
select plan(11);

insert into public.users (id) values ('user_a'), ('user_b');
insert into public.alarms (id, user_id, device_id, hour, minute) values
  ('a0000000-0000-0000-0000-00000000000a', 'user_a', 'd0000000-0000-0000-0000-00000000000a', 7, 0),
  ('a0000000-0000-0000-0000-00000000000b', 'user_b', 'd0000000-0000-0000-0000-00000000000b', 7, 0);

-- user_a, ISO week of 2026-10-05 (Mon): 4 occurrences.
--   Mon 10-05 dismissed, 0 snoozes, session success (math)
--   Tue 10-06 dismissed, 2 snoozes, session failed (wake check failed) (math > steps)
--   Wed 10-07 missed
--   Thu 10-08 skipped (ignored everywhere)
insert into public.alarm_occurrences (id, user_id, device_id, alarm_id, occurrence_key, local_date, expected_at, triggered_at, dismissed_at, snooze_count, outcome) values
  ('0c000000-0000-0000-0000-000000000001', 'user_a', 'd0000000-0000-0000-0000-00000000000a', 'a0000000-0000-0000-0000-00000000000a', 'k1', '2026-10-05', '2026-10-05 07:00+00', '2026-10-05 07:00+00', '2026-10-05 07:02+00', 0, 'dismissed'),
  ('0c000000-0000-0000-0000-000000000002', 'user_a', 'd0000000-0000-0000-0000-00000000000a', 'a0000000-0000-0000-0000-00000000000a', 'k2', '2026-10-06', '2026-10-06 07:00+00', '2026-10-06 07:00+00', '2026-10-06 07:20+00', 2, 'dismissed'),
  ('0c000000-0000-0000-0000-000000000003', 'user_a', 'd0000000-0000-0000-0000-00000000000a', 'a0000000-0000-0000-0000-00000000000a', 'k3', '2026-10-07', '2026-10-07 07:00+00', '2026-10-07 07:00+00', null, 4, 'missed'),
  ('0c000000-0000-0000-0000-000000000004', 'user_a', 'd0000000-0000-0000-0000-00000000000a', 'a0000000-0000-0000-0000-00000000000a', 'k4', '2026-10-08', '2026-10-08 07:00+00', null, null, 0, 'skipped');
insert into public.alarm_occurrences (id, user_id, device_id, alarm_id, occurrence_key, local_date, expected_at, triggered_at, dismissed_at, outcome) values
  ('0c000000-0000-0000-0000-0000000000b1', 'user_b', 'd0000000-0000-0000-0000-00000000000b', 'a0000000-0000-0000-0000-00000000000b', 'k1', '2026-10-05', '2026-10-05 07:00+00', '2026-10-05 07:00+00', '2026-10-05 07:01+00', 'dismissed');

insert into public.wake_sessions (id, user_id, device_id, alarm_occurrence_id, started_at, ended_at, status, retrigger_count) values
  ('e0000000-0000-0000-0000-000000000001', 'user_a', 'd0000000-0000-0000-0000-00000000000a', '0c000000-0000-0000-0000-000000000001', '2026-10-05 07:00+00', '2026-10-05 07:15+00', 'success', 0),
  ('e0000000-0000-0000-0000-000000000002', 'user_a', 'd0000000-0000-0000-0000-00000000000a', '0c000000-0000-0000-0000-000000000002', '2026-10-06 07:00+00', '2026-10-06 07:40+00', 'failed', 1);

insert into public.mission_attempts (id, user_id, device_id, wake_session_id, mission_type, position, started_at, ended_at, outcome) values
  (gen_random_uuid(), 'user_a', 'd0000000-0000-0000-0000-00000000000a', 'e0000000-0000-0000-0000-000000000001', 'math',  0, '2026-10-05 07:00+00', '2026-10-05 07:01+00', 'completed'),
  (gen_random_uuid(), 'user_a', 'd0000000-0000-0000-0000-00000000000a', 'e0000000-0000-0000-0000-000000000002', 'math',  0, '2026-10-06 07:00+00', '2026-10-06 07:02+00', 'failed'),
  (gen_random_uuid(), 'user_a', 'd0000000-0000-0000-0000-00000000000a', 'e0000000-0000-0000-0000-000000000002', 'math',  0, '2026-10-06 07:03+00', '2026-10-06 07:05+00', 'completed'),  -- retry: chain stays "math > steps"
  (gen_random_uuid(), 'user_a', 'd0000000-0000-0000-0000-00000000000a', 'e0000000-0000-0000-0000-000000000002', 'steps', 1, '2026-10-06 07:06+00', '2026-10-06 07:10+00', 'completed');

insert into public.wake_checks (id, user_id, device_id, wake_session_id, check_number, method, due_at, responded_at, outcome) values
  (gen_random_uuid(), 'user_a', 'd0000000-0000-0000-0000-00000000000a', 'e0000000-0000-0000-0000-000000000001', 1, 'confirm', '2026-10-05 07:10+00', '2026-10-05 07:11+00', 'passed'),
  (gen_random_uuid(), 'user_a', 'd0000000-0000-0000-0000-00000000000a', 'e0000000-0000-0000-0000-000000000002', 1, 'confirm', '2026-10-06 07:25+00', null, 'no_response'),
  (gen_random_uuid(), 'user_a', 'd0000000-0000-0000-0000-00000000000a', 'e0000000-0000-0000-0000-000000000002', 2, 'confirm', '2026-10-06 07:35+00', '2026-10-06 07:36+00', 'failed');

insert into public.sleep_sessions (id, user_id, device_id, started_at, ended_at, local_date) values
  (gen_random_uuid(), 'user_a', 'd0000000-0000-0000-0000-00000000000a', '2026-10-04 23:30+00', '2026-10-05 07:00+00', '2026-10-05'),   -- 7.5h
  (gen_random_uuid(), 'user_a', 'd0000000-0000-0000-0000-00000000000a', '2026-10-06 01:00+00', '2026-10-06 07:00+00', '2026-10-06');   -- 6h
insert into public.morning_checkins (id, user_id, device_id, local_date, energy, sleep_quality) values
  (gen_random_uuid(), 'user_a', 'd0000000-0000-0000-0000-00000000000a', '2026-10-05', 5, 4),
  (gen_random_uuid(), 'user_a', 'd0000000-0000-0000-0000-00000000000a', '2026-10-06', 2, 2);

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"user_a","role":"authenticated"}', true);

select results_eq($$select alarms_counted::int, successful_wakes::int, success_rate from public.analytics_wake_success_weekly$$,
  $$values (3, 1, 0.333::numeric)$$, 'weekly wake success: 1 of 3 (skipped ignored, failed wake check counts as failure)');
select results_eq($$select week_start from public.analytics_wake_success_weekly$$,
  $$values ('2026-10-05'::date)$$, 'week_start is the ISO Monday');
select results_eq($$select alarms_rang::int, avg_snoozes, alarms_snoozed::int from public.analytics_avg_snoozes_weekly$$,
  $$values (3, 2.00::numeric, 2)$$, 'average snoozes per rang alarm');
select results_eq($$select mission_type, attempts::int, completed::int, session_success_rate from public.analytics_mission_effectiveness order by mission_type$$,
  $$values ('math'::text, 3, 2, 0.5::numeric), ('steps', 1, 1, 0.0::numeric)$$, 'mission effectiveness by type');
select results_eq($$select chain, chain_length::int, sessions::int, success_rate from public.analytics_mission_chain_effectiveness order by chain$$,
  $$values ('math'::text, 1, 1, 1.000::numeric), ('math > steps', 2, 1, 0.000::numeric)$$, 'chain effectiveness; retries do not lengthen the chain');
select results_eq($$select checks::int, failed_checks::int, failure_rate from public.analytics_wake_check_failure_weekly$$,
  $$values (3, 2, 0.667::numeric)$$, 'wake check failure rate');
select results_eq($$select iso_weekday::int, alarms_counted::int, success_rate, avg_snoozes from public.analytics_weekday_difficulty order by 1$$,
  $$values (1, 1, 1.000::numeric, 0.00::numeric), (2, 1, 0.000::numeric, 2.00::numeric), (3, 1, 0.000::numeric, 4.00::numeric)$$, 'weekday difficulty');
select results_eq($$select sleep_bucket, nights::int, avg_sleep_hours, avg_energy from public.analytics_sleep_vs_energy order by bucket_order$$,
  $$values ('6-7h'::text, 1, 6.00::numeric, 2.00::numeric), ('7-8h', 1, 7.50::numeric, 5.00::numeric)$$, 'sleep duration vs morning energy');

-- Scope: user_b only sees their own data through the views.
select set_config('request.jwt.claims', '{"sub":"user_b","role":"authenticated"}', true);
select results_eq($$select alarms_counted::int, success_rate from public.analytics_wake_success_weekly$$,
  $$values (1, 1.000::numeric)$$, 'user_b sees only their own weekly stats');
select is((select count(*)::int from public.analytics_mission_effectiveness), 0, 'user_b sees none of user_a''s mission stats');
select is((select count(*)::int from public.analytics_sleep_vs_energy), 0, 'user_b sees none of user_a''s sleep stats');

select * from finish();
rollback;
