-- Sync plumbing, Row Level Security and grants for every table.
--
-- Access model (docs/DECISIONS.md D16):
--   * anon: no privileges on anything.
--   * authenticated (Clerk JWT): sees and writes only rows where (select auth.jwt()->>'sub') = user_id.
--     Syncable tables get select/insert/update only - deletes are soft (deleted_at tombstone) so other
--     devices can pull them; hard deletion is delete_my_data().
--   * entitlements, ai_insights: client read-only. missions: client read-only catalog.
--   * events: append-only (select/insert; update blocked by trigger, delete not granted).
--   * service_role (Edge Functions) bypasses RLS and keeps its default grants.
-- (select auth.jwt()->>'sub') is wrapped in a sub-select so Postgres evaluates it once per statement
-- (initplan) instead of once per row.
--
-- Table lists are explicit on purpose: a new table is not accessible to clients until it is added
-- here (or in its own migration with the same pattern). supabase/tests/database/ fails the build if
-- any public table lacks RLS or is reachable by anon.

do $$
declare
  t text;
  syncable text[] := array[
    'devices', 'alarms', 'alarm_occurrences', 'wake_sessions', 'mission_attempts', 'wake_checks',
    'sleep_sessions', 'morning_checkins', 'preferences', 'sync_state',
    'ai_insights', 'entitlements', 'data_export_requests'
  ];
  client_rw text[] := array[
    'devices', 'alarms', 'alarm_occurrences', 'wake_sessions', 'mission_attempts', 'wake_checks',
    'sleep_sessions', 'morning_checkins', 'preferences', 'sync_state'
  ];
  client_ro text[] := array['ai_insights', 'entitlements'];
  all_tables text[] := array[
    'users', 'missions', 'events',
    'devices', 'alarms', 'alarm_occurrences', 'wake_sessions', 'mission_attempts', 'wake_checks',
    'sleep_sessions', 'morning_checkins', 'preferences', 'sync_state',
    'ai_insights', 'entitlements', 'data_export_requests'
  ];
begin
  -- RLS on, and no implicit grants for anon/authenticated.
  foreach t in array all_tables loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;

  -- Sync pulls: `where user_id = $1 and updated_at > $cursor order by updated_at`.
  foreach t in array syncable loop
    execute format('create trigger %I before insert or update on public.%I for each row execute function public.sync_touch()',
      t || '_sync_touch', t);
    execute format('create index %I on public.%I (user_id, updated_at)', t || '_user_updated_idx', t);
  end loop;

  -- Client read/write (no delete).
  foreach t in array client_rw loop
    execute format('grant select, insert, update on public.%I to authenticated', t);
    execute format('create policy %I on public.%I for select to authenticated using ((select auth.jwt()->>''sub'') = user_id)',
      t || '_select_own', t);
    execute format('create policy %I on public.%I for insert to authenticated with check ((select auth.jwt()->>''sub'') = user_id)',
      t || '_insert_own', t);
    execute format('create policy %I on public.%I for update to authenticated using ((select auth.jwt()->>''sub'') = user_id) with check ((select auth.jwt()->>''sub'') = user_id)',
      t || '_update_own', t);
  end loop;

  -- Client read-only (writes: service role only).
  foreach t in array client_ro loop
    execute format('grant select on public.%I to authenticated', t);
    execute format('create policy %I on public.%I for select to authenticated using ((select auth.jwt()->>''sub'') = user_id)',
      t || '_select_own', t);
  end loop;
end
$$;

-- users: the row id is the Clerk user id.
grant select, insert, update on public.users to authenticated;
create policy users_select_own on public.users for select to authenticated
  using ((select auth.jwt()->>'sub') = id);
create policy users_insert_own on public.users for insert to authenticated
  with check ((select auth.jwt()->>'sub') = id);
create policy users_update_own on public.users for update to authenticated
  using ((select auth.jwt()->>'sub') = id) with check ((select auth.jwt()->>'sub') = id);

-- missions: shared catalog, read-only.
grant select on public.missions to authenticated;
create policy missions_select_all on public.missions for select to authenticated using (true);

-- events: append-only, client may insert and read its own.
grant select, insert on public.events to authenticated;
create policy events_select_own on public.events for select to authenticated
  using ((select auth.jwt()->>'sub') = user_id);
create policy events_insert_own on public.events for insert to authenticated
  with check ((select auth.jwt()->>'sub') = user_id);
create index events_user_occurred_idx on public.events (user_id, occurred_at);
create index events_user_name_occurred_idx on public.events (user_id, name, occurred_at);

-- data_export_requests: client may create a request and read it; only the service role progresses it.
grant select, insert on public.data_export_requests to authenticated;
create policy data_export_requests_select_own on public.data_export_requests for select to authenticated
  using ((select auth.jwt()->>'sub') = user_id);
create policy data_export_requests_insert_own on public.data_export_requests for insert to authenticated
  with check (
    (select auth.jwt()->>'sub') = user_id
    and status = 'requested' and completed_at is null and storage_path is null and error is null
  );

-- Indexes beyond (user_id, updated_at): composite-FK lookups and analytics.
create index alarm_occurrences_alarm_idx      on public.alarm_occurrences (alarm_id);
create index alarm_occurrences_user_date_idx  on public.alarm_occurrences (user_id, local_date);
create index alarm_occurrences_user_expected_idx on public.alarm_occurrences (user_id, expected_at);
create index mission_attempts_session_idx     on public.mission_attempts (wake_session_id);
create index wake_checks_due_idx              on public.wake_checks (user_id, due_at);
create index sleep_sessions_user_date_idx     on public.sleep_sessions (user_id, local_date);
create index entitlements_active_idx          on public.entitlements (user_id) where is_active;

-- Belt and braces: nothing in public is executable by anon/public unless granted explicitly.
revoke all on all tables in schema public from anon;
revoke execute on all functions in schema public from anon, public;
