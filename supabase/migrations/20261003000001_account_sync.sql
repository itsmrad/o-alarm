-- Account + cloud sync (docs/DECISIONS.md D22, D25, D26).
--
-- 1. Close the local<->cloud alarm gaps (D25). The local domain model (src/domain/alarm.ts) is the source
--    of truth, so cloud bounds follow it exactly: a row the cloud accepts must always map back to a
--    valid local alarm.
-- 2. `alarm_deleted` joins the events allow-list (D26).
-- 3. Pro gating of cloud sync is enforced on writes (D22): restrictive RLS policies require the `pro`
--    entitlement (service-role-managed `entitlements` table) or an open one-time guest->account
--    migration window. Reads, export_my_data() and delete_my_data() stay open to every signed-in user.

-- 1. alarms: fields the local model has and the cloud lacked, and bounds that differed.
alter table public.alarms
  add column important                          boolean not null default false,
  add column gradual_volume_ramp_seconds        smallint not null default 30
    check (gradual_volume_ramp_seconds between 0 and 600),
  add column wake_check_response_window_seconds smallint not null default 60
    check (wake_check_response_window_seconds between 15 and 600),
  add column wake_check_max_retriggers          smallint not null default 3
    check (wake_check_max_retriggers between 1 and 10),
  add column wake_check_mission_id              text
    check (wake_check_mission_id is null or length(wake_check_mission_id) between 1 and 64);

-- Local label max is 60 (was 100 in the cloud).
alter table public.alarms drop constraint alarms_label_check;
alter table public.alarms add constraint alarms_label_check check (length(label) <= 60);

-- Local Wake Check delay is 1..60 minutes (was 1..30 in the cloud).
alter table public.alarms drop constraint alarms_wake_check_delay_minutes_check;
alter table public.alarms add constraint alarms_wake_check_delay_minutes_check
  check (wake_check_delay_minutes between 1 and 60);

-- Local snooze limit is 0..10 and never unlimited (was 0..20 or null = unlimited).
update public.alarms set snooze_limit = 10 where snooze_limit is null or snooze_limit > 10;
alter table public.alarms drop constraint alarms_snooze_limit_check;
alter table public.alarms
  alter column snooze_limit set default 3,
  alter column snooze_limit set not null,
  add constraint alarms_snooze_limit_check check (snooze_limit between 0 and 10);

-- `sound` encodes the local {kind, id} object as '<kind>' (id null) or '<kind>:<id>'.
alter table public.alarms add constraint alarms_sound_format
  check (sound is null or sound ~ '^(default|system|custom)(:.+)?$');

-- A "mission" Wake Check needs its mission (same rule as the local schema).
alter table public.alarms add constraint alarms_wake_check_mission_needs_id
  check (wake_check_method <> 'mission' or wake_check_mission_id is not null);

-- 2. events: alarm_deleted (D26).
alter table public.events drop constraint events_name_check;
alter table public.events add constraint events_name_check check (name in (
  'alarm_created', 'alarm_updated', 'alarm_deleted', 'alarm_native_scheduled', 'alarm_schedule_failed',
  'alarm_expected', 'alarm_trigger_received', 'alarm_snoozed', 'alarm_dismissed',
  'mission_started', 'mission_completed', 'mission_failed',
  'wake_check_started', 'wake_check_passed', 'wake_check_failed', 'alarm_retriggered'
));

-- 3. Pro gating (D22).

-- One guest->account migration per account, regardless of tier. Written only through
-- begin_guest_migration() / complete_guest_migration(); clients can read their own row.
create table public.guest_migrations (
  user_id      text primary key references public.users (id) on delete cascade,
  device_id    uuid not null,                     -- device that ran the migration
  created_at   timestamptz not null default now(),
  started_at   timestamptz not null default now(),
  completed_at timestamptz
);
alter table public.guest_migrations enable row level security;
revoke all on public.guest_migrations from anon, authenticated;
grant select on public.guest_migrations to authenticated;
create policy guest_migrations_select_own on public.guest_migrations for select to authenticated
  using ((select auth.jwt()->>'sub') = user_id);

-- A started migration may upload for this long (resumable across app restarts / offline periods),
-- then the window closes even if the client never completes it.
create function public.guest_migration_window()
returns interval
language sql
immutable
set search_path = ''
as $$ select interval '7 days' $$;

-- True when the caller holds an active entitlement (RevenueCat mirror, written by the service role).
create function public.has_entitlement(p_entitlement text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.entitlements e
    where e.user_id = (select auth.jwt()->>'sub')
      and e.entitlement = p_entitlement
      and e.is_active
      and e.deleted_at is null
      and (e.expires_at is null or e.expires_at > now())
  )
$$;

create function public.guest_migration_open()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.guest_migrations g
    where g.user_id = (select auth.jwt()->>'sub')
      and g.completed_at is null
      and g.started_at > now() - public.guest_migration_window()
  )
$$;

-- Write gate for every client-writable sync table.
create function public.can_write_sync()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$ select public.has_entitlement('pro') or public.guest_migration_open() $$;

-- Opens the caller's one-time migration window (idempotent: a second call never reopens or extends it).
-- Returns {open, started_at, completed_at}; open = uploads are currently allowed by the migration window.
create function public.begin_guest_migration(p_device_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid text := auth.jwt()->>'sub';
  g   public.guest_migrations;
begin
  if uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  insert into public.users (id) values (uid) on conflict (id) do nothing;
  insert into public.guest_migrations (user_id, device_id) values (uid, p_device_id)
    on conflict (user_id) do nothing;
  select * into g from public.guest_migrations where user_id = uid;
  return jsonb_build_object(
    'open', g.completed_at is null and g.started_at > now() - public.guest_migration_window(),
    'started_at', g.started_at,
    'completed_at', g.completed_at
  );
end;
$$;

create function public.complete_guest_migration()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid text := auth.jwt()->>'sub';
  g   public.guest_migrations;
begin
  if uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  update public.guest_migrations set completed_at = coalesce(completed_at, now())
    where user_id = uid returning * into g;
  return jsonb_build_object('open', false, 'started_at', g.started_at, 'completed_at', g.completed_at);
end;
$$;

-- Restrictive policies AND with the existing "own row" policies: writes need ownership AND the gate.
-- users (account row) and data_export_requests (privacy) stay ungated on purpose.
do $$
declare
  t text;
  gated text[] := array[
    'devices', 'alarms', 'alarm_occurrences', 'wake_sessions', 'mission_attempts', 'wake_checks',
    'sleep_sessions', 'morning_checkins', 'preferences', 'sync_state', 'events'
  ];
begin
  foreach t in array gated loop
    execute format('create policy %I on public.%I as restrictive for insert to authenticated with check ((select public.can_write_sync()))',
      t || '_insert_requires_pro', t);
    if t <> 'events' then
      execute format('create policy %I on public.%I as restrictive for update to authenticated using (true) with check ((select public.can_write_sync()))',
        t || '_update_requires_pro', t);
    end if;
  end loop;
end
$$;

-- guest_migrations is user-owned: export and delete must cover it.
create or replace function public.user_data_tables()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array[
    'devices', 'alarms', 'alarm_occurrences', 'wake_sessions', 'mission_attempts', 'wake_checks',
    'sleep_sessions', 'morning_checkins', 'preferences', 'sync_state',
    'ai_insights', 'entitlements', 'data_export_requests', 'events', 'guest_migrations'
  ]
$$;

revoke all on function public.guest_migration_window(), public.guest_migration_open(), public.user_data_tables()
  from public, anon, authenticated;
revoke all on function public.has_entitlement(text), public.can_write_sync(),
  public.begin_guest_migration(uuid), public.complete_guest_migration() from public, anon;
grant execute on function public.has_entitlement(text), public.can_write_sync(),
  public.begin_guest_migration(uuid), public.complete_guest_migration() to authenticated;
