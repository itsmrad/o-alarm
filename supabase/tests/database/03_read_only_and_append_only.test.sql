-- entitlements / ai_insights / missions: clients read, only the service role writes.
-- events: append-only. data_export_requests: clients may only create 'requested' rows.
begin;
select plan(20);

insert into public.users (id) values ('user_a');
insert into public.ai_insights (user_id, type, period_start, period_end, structured, model)
  values ('user_a', 'weekly_report', '2026-09-28', '2026-10-04', '{"success_rate": 0.9}', 'test-model');
insert into public.entitlements (id, user_id, is_active) values ('e1000000-0000-0000-0000-00000000000a', 'user_a', true);

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"user_a","role":"authenticated"}', true);

select is((select count(*)::int from public.ai_insights), 1, 'client can read own ai_insights');
select is((select count(*)::int from public.entitlements), 1, 'client can read own entitlements');

select throws_ok($$insert into public.entitlements (user_id, is_active) values ('user_a', true)$$,
  '42501', null, 'client cannot insert entitlements');
select throws_ok($$update public.entitlements set is_active = false$$, '42501', null, 'client cannot update entitlements');
select throws_ok($$delete from public.entitlements$$, '42501', null, 'client cannot delete entitlements');
select throws_ok($$insert into public.ai_insights (user_id, type, period_start, period_end, structured)
  values ('user_a', 'wake_pattern', '2026-09-28', '2026-10-04', '{}')$$,
  '42501', null, 'client cannot insert ai_insights');
select throws_ok($$update public.ai_insights set explanation = 'x'$$, '42501', null, 'client cannot update ai_insights');
select throws_ok($$delete from public.ai_insights$$, '42501', null, 'client cannot delete ai_insights');
select throws_ok($$insert into public.missions (type, display_name, tier) values ('hack', 'Hack', 'free')$$,
  '42501', null, 'client cannot insert catalog missions');
select throws_ok($$update public.missions set tier = 'free'$$, '42501', null, 'client cannot update catalog missions');

-- events: insert + select only.
select lives_ok($$insert into public.events (id, user_id, device_id, name, occurred_at)
  values ('e7000000-0000-0000-0000-0000000000a1', 'user_a', 'd0000000-0000-0000-0000-00000000000a', 'alarm_created', now())$$,
  'client can append an event');
select throws_ok($$update public.events set name = 'alarm_updated'$$, '42501', null, 'client cannot update events');
select throws_ok($$delete from public.events$$, '42501', null, 'client cannot delete events');

-- data_export_requests: only fresh 'requested' rows.
select lives_ok($$insert into public.data_export_requests (user_id) values ('user_a')$$, 'client can request an export');
select throws_ok($$insert into public.data_export_requests (user_id, status) values ('user_a', 'ready')$$,
  '42501', null, 'client cannot fabricate a finished export');
select throws_ok($$update public.data_export_requests set status = 'ready'$$, '42501', null, 'client cannot update export requests');

-- Service role (Edge Functions) can write them.
reset role;
set local role service_role;
select lives_ok($$update public.entitlements set is_active = false, expires_at = now() where user_id = 'user_a'$$,
  'service_role can update entitlements');
select lives_ok($$insert into public.ai_insights (user_id, type, period_start, period_end, structured)
  values ('user_a', 'wake_pattern', '2026-09-28', '2026-10-04', '{}')$$, 'service_role can insert ai_insights');
select lives_ok($$update public.data_export_requests set status = 'ready' where user_id = 'user_a'$$,
  'service_role can progress export requests');

-- Even the owner role cannot rewrite history in events.
reset role;
select throws_ok($$update public.events set name = 'alarm_updated'$$, '55000', 'events is append-only',
  'events update is blocked by trigger for every role');

select * from finish();
rollback;
