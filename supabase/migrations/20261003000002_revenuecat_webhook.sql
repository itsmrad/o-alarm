-- RevenueCat webhook support (D18, D22). Everything here is service-role only: the Edge Function
-- `revenuecat-webhook` calls apply_revenuecat_entitlement(); the client never touches it.
--
--   revenuecat_events  one row per processed webhook event id => idempotent redelivery (RevenueCat
--                      retries non-2xx responses and may deliver at-least-once). Keyed by
--                      `app_user_id` (not `user_id`) on purpose: it has no FK, so it survives the
--                      cascade of delete_my_data() and is erased by the delete-account-cleanup
--                      function instead. Rows older than 30 days are pruned on write.
--   apply_revenuecat_entitlement()  records the event and upserts the `entitlements` mirror in ONE
--                      transaction, dropping out-of-order events via entitlements.latest_event_at.
--   current_user_id()  the verified Clerk id of the caller (JWT sub); lets Edge Functions that must
--                      run without Supabase JWT verification prove who is calling.

create table public.revenuecat_events (
  event_id     text primary key check (length(event_id) between 1 and 255),
  event_type   text not null,
  app_user_id  text not null,
  event_at     timestamptz,
  outcome      text not null check (outcome in ('applied', 'stale', 'skipped')),
  received_at  timestamptz not null default now()
);
create index revenuecat_events_app_user_idx on public.revenuecat_events (app_user_id);
create index revenuecat_events_received_idx on public.revenuecat_events (received_at);

alter table public.revenuecat_events enable row level security;  -- no policies: service role only
revoke all on table public.revenuecat_events from anon, authenticated, public;
grant select, insert, update, delete on table public.revenuecat_events to service_role;

create function public.apply_revenuecat_entitlement(
  p_event_id             text,
  p_event_type           text,
  p_app_user_id          text,
  p_entitlement          text,
  p_is_active            boolean,
  p_product_id           text,
  p_store                text,
  p_environment          text,
  p_period_type          text,
  p_will_renew           boolean,
  p_original_purchase_at timestamptz,
  p_expires_at           timestamptz,
  p_event_at             timestamptz
)
returns text                                   -- 'applied' | 'stale' | 'skipped' | 'duplicate'
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_outcome  text;
  v_rows     int;
  v_event_at timestamptz := coalesce(p_event_at, now());   -- ordering key for the stale check
begin
  insert into public.revenuecat_events (event_id, event_type, app_user_id, event_at, outcome)
    values (p_event_id, p_event_type, p_app_user_id, v_event_at, 'applied')
    on conflict (event_id) do nothing;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    return 'duplicate';
  end if;

  delete from public.revenuecat_events where received_at < now() - interval '30 days';

  -- A deactivating event for a user we have no row for (never synced, or already deleted) has
  -- nothing to deactivate. Do not resurrect a deleted account's `users` row for it.
  if not p_is_active and not exists (select 1 from public.users where id = p_app_user_id) then
    update public.revenuecat_events set outcome = 'skipped' where event_id = p_event_id;
    return 'skipped';
  end if;

  -- A purchase can precede the user's first sync: entitlements.user_id has an FK to users.
  insert into public.users (id) values (p_app_user_id) on conflict (id) do nothing;

  insert into public.entitlements as e (
    user_id, entitlement, is_active, product_id, store, environment, period_type, will_renew,
    original_purchase_at, expires_at, latest_event_at
  ) values (
    p_app_user_id, p_entitlement, p_is_active, p_product_id, p_store, p_environment, p_period_type,
    p_will_renew, p_original_purchase_at, p_expires_at, v_event_at
  )
  on conflict (user_id, entitlement) do update set
    is_active            = excluded.is_active,
    product_id           = coalesce(excluded.product_id, e.product_id),
    store                = coalesce(excluded.store, e.store),
    environment          = excluded.environment,
    period_type          = coalesce(excluded.period_type, e.period_type),
    will_renew           = excluded.will_renew,
    original_purchase_at = coalesce(e.original_purchase_at, excluded.original_purchase_at),
    expires_at           = excluded.expires_at,
    latest_event_at      = excluded.latest_event_at,
    deleted_at           = null
  where e.latest_event_at is null or e.latest_event_at <= excluded.latest_event_at;
  get diagnostics v_rows = row_count;

  v_outcome := case when v_rows > 0 then 'applied' else 'stale' end;
  if v_outcome = 'stale' then
    update public.revenuecat_events set outcome = 'stale' where event_id = p_event_id;
  end if;
  return v_outcome;
end;
$$;

-- Verified caller identity (Clerk id) for Edge Functions that run with verify_jwt = false.
create function public.current_user_id()
returns text
language sql
stable
set search_path = ''
as $$ select (select auth.jwt()->>'sub') $$;

revoke all on function public.apply_revenuecat_entitlement(
  text, text, text, text, boolean, text, text, text, text, boolean, timestamptz, timestamptz, timestamptz
) from public, anon, authenticated;
grant execute on function public.apply_revenuecat_entitlement(
  text, text, text, text, boolean, text, text, text, text, boolean, timestamptz, timestamptz, timestamptz
) to service_role;

revoke all on function public.current_user_id() from public, anon;
grant execute on function public.current_user_id() to authenticated;
