-- claim_ai_quota(): rolling 7-day limit per user + bucket, service-role only; ai_usage closed to clients.
begin;
select plan(15);

insert into public.users (id) values ('ai_user'), ('ai_other');

set local role service_role;
select isnt(public.claim_ai_quota('ai_user', 'weekly_report', 1), null, 'first weekly report is allowed');
select is(public.claim_ai_quota('ai_user', 'weekly_report', 1), null, 'second weekly report in 7 days is limited');
select isnt(public.claim_ai_quota('ai_user', 'explanation', 10), null, 'buckets are counted separately');
select isnt(public.claim_ai_quota('ai_other', 'weekly_report', 1), null, 'limits are per user');

-- Ten explanations, then the eleventh is refused.
select is(
  (select count(*)::int from generate_series(1, 9) g
     where public.claim_ai_quota('ai_user', 'explanation', 10) is not null),
  9, 'explanations 2..10 are allowed');
select is(public.claim_ai_quota('ai_user', 'explanation', 10), null, 'the 11th explanation is limited');

-- Uses older than 7 days fall out of the window.
reset role;
update public.ai_usage set created_at = now() - interval '8 days'
  where user_id = 'ai_user' and bucket = 'weekly_report';
set local role service_role;
select isnt(public.claim_ai_quota('ai_user', 'weekly_report', 1), null, 'window is rolling 7 days');

-- A released claim (upstream failure) frees the slot.
delete from public.ai_usage where user_id = 'ai_other';
select isnt(public.claim_ai_quota('ai_other', 'weekly_report', 1), null, 'released claim frees the slot');

select throws_ok($$select public.claim_ai_quota('ai_user', 'chat', 1)$$, '23514', null, 'unknown bucket rejected');
select throws_ok($$select public.claim_ai_quota('nobody', 'explanation', 1)$$, '23503', null, 'needs an existing user');

-- Clients: no table access, cannot claim quota for anyone.
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"ai_user","role":"authenticated"}', true);
select throws_ok($$select * from public.ai_usage$$, '42501', null, 'clients cannot read ai_usage');
select throws_ok($$delete from public.ai_usage$$, '42501', null, 'clients cannot delete ai_usage');
select throws_ok($$select public.claim_ai_quota('ai_user', 'explanation', 100)$$, '42501', null,
  'clients cannot call claim_ai_quota');

-- delete_my_data() removes the caller's usage rows (cascade via users).
select lives_ok($$select public.delete_my_data()$$, 'delete_my_data runs');
reset role;
select is((select count(*)::int from public.ai_usage where user_id = 'ai_user'), 0,
  'delete_my_data removes the caller''s ai_usage rows');

select * from finish();
rollback;
