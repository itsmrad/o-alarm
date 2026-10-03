-- apply_revenuecat_entitlement(): idempotent per event id, out-of-order safe, service-role only.
begin;
select plan(19);

-- Event helper: (event id, type, user, active, expires_at, event_at)
create function pg_temp.ev(p_id text, p_type text, p_user text, p_active boolean, p_exp timestamptz, p_at timestamptz)
returns text language sql as $$
  select public.apply_revenuecat_entitlement(
    p_id, p_type, p_user, 'pro', p_active, 'pro_monthly', 'app_store', 'production', 'normal',
    p_active, '2026-10-01T00:00:00Z', p_exp, p_at)
$$;
grant execute on function pg_temp.ev(text, text, text, boolean, timestamptz, timestamptz) to service_role;

set local role service_role;

-- A purchase that precedes the user's first sync creates the users row and the entitlement.
select is(pg_temp.ev('evt-1', 'INITIAL_PURCHASE', 'rc_user', true, now() + interval '30 days', '2026-10-01T00:00:00Z'),
  'applied', 'first event is applied');
select is((select count(*)::int from public.users where id = 'rc_user'), 1, 'users row created for a purchase before first sync');
select is((select is_active from public.entitlements where user_id = 'rc_user'), true, 'entitlement is active');
select is((select store from public.entitlements where user_id = 'rc_user'), 'app_store', 'store recorded');

-- Redelivery of the same event id is a no-op.
select is(pg_temp.ev('evt-1', 'INITIAL_PURCHASE', 'rc_user', true, now() + interval '30 days', '2026-10-01T00:00:00Z'),
  'duplicate', 'same event id is idempotent');
select is((select version from public.entitlements where user_id = 'rc_user'), 1::bigint, 'duplicate did not touch the row');

-- Later event wins; an older one delivered afterwards is dropped.
select is(pg_temp.ev('evt-3', 'EXPIRATION', 'rc_user', false, '2026-10-02T00:00:00Z', '2026-10-02T00:00:00Z'),
  'applied', 'later event applies');
select is(pg_temp.ev('evt-2', 'RENEWAL', 'rc_user', true, now() + interval '60 days', '2026-10-01T12:00:00Z'),
  'stale', 'out-of-order older event is stale');
select is((select is_active from public.entitlements where user_id = 'rc_user'), false, 'stale event did not reactivate');
select is((select outcome from public.revenuecat_events where event_id = 'evt-2'), 'stale', 'stale outcome recorded');

-- A new purchase after expiry reactivates; original_purchase_at is kept from the first event.
select is(pg_temp.ev('evt-4', 'RENEWAL', 'rc_user', true, now() + interval '30 days', '2026-10-03T00:00:00Z'),
  'applied', 'reactivation applies');
select is((select original_purchase_at from public.entitlements where user_id = 'rc_user'), '2026-10-01T00:00:00Z'::timestamptz, 'original purchase date preserved');

-- A deactivating event for an unknown user does not create an account row.
select is(pg_temp.ev('evt-5', 'EXPIRATION', 'ghost', false, '2026-10-02T00:00:00Z', '2026-10-02T00:00:00Z'),
  'skipped', 'deactivation for an unknown user is skipped');
select is((select count(*)::int from public.users where id = 'ghost'), 0, 'no users row resurrected');

-- The gate (D22) follows the mirror.
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"rc_user","role":"authenticated"}', true);
select ok(public.has_entitlement('pro'), 'has_entitlement(pro) is true for the purchaser');
select is(public.current_user_id(), 'rc_user', 'current_user_id() returns the verified sub');
select throws_ok($$select * from public.revenuecat_events$$, '42501', null, 'clients cannot read webhook events');
select throws_ok(
  $$select public.apply_revenuecat_entitlement('x','X','rc_user','pro',true,null,null,'production',null,true,null,null,now())$$,
  '42501', null, 'clients cannot call the webhook function');

reset role;
set local role anon;
select throws_ok($$select public.current_user_id()$$, '42501', null, 'anon cannot call current_user_id');

select * from finish();
rollback;
