-- Privacy: export and delete everything the caller owns (docs/PRODUCT.md "support export/delete").
-- SECURITY DEFINER so they can read/delete across all tables in one call, but scoped strictly to the
-- caller's Clerk id from the JWT; they raise for unauthenticated callers and are not executable by anon.
--
-- delete_my_data() removes cloud rows only. Deleting the Clerk user and the RevenueCat subscriber
-- record are outside SQL (Edge Function with the respective admin keys); the app should call this
-- first, then that function, then drop local data.

-- Single list of per-user tables used by both functions (everything with a user_id column).
-- tests/database/07_data_functions.test.sql fails if a new user-owned table is missing from it.
create function public.user_data_tables()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array[
    'devices', 'alarms', 'alarm_occurrences', 'wake_sessions', 'mission_attempts', 'wake_checks',
    'sleep_sessions', 'morning_checkins', 'preferences', 'sync_state',
    'ai_insights', 'entitlements', 'data_export_requests', 'events'
  ]
$$;

create function public.export_my_data()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid  text := auth.jwt()->>'sub';
  t    text;
  rows jsonb;
  tables jsonb := '{}';
begin
  if uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  foreach t in array public.user_data_tables() loop
    execute format(
      'select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at), ''[]'') from public.%I x where x.user_id = $1', t)
      into rows using uid;
    tables := tables || jsonb_build_object(t, rows);
  end loop;

  return jsonb_build_object(
    'exported_at', now(),
    'user_id', uid,
    'user', (select to_jsonb(u) from public.users u where u.id = uid),
    'tables', tables
  );
end;
$$;

-- Hard-deletes the user and (via ON DELETE CASCADE) every row they own, tombstones and events included.
-- Returns the number of rows removed per table.
create function public.delete_my_data()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid    text := auth.jwt()->>'sub';
  t      text;
  n      bigint;
  counts jsonb := '{}';
begin
  if uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  foreach t in array public.user_data_tables() loop
    execute format('select count(*) from public.%I where user_id = $1', t) into n using uid;
    counts := counts || jsonb_build_object(t, n);
  end loop;

  delete from public.users where id = uid returning 1 into n;
  counts := counts || jsonb_build_object('users', coalesce(n, 0));
  return counts;
end;
$$;

revoke all on function public.user_data_tables() from public, anon, authenticated;
revoke all on function public.export_my_data(), public.delete_my_data() from public, anon;
grant execute on function public.export_my_data(), public.delete_my_data() to authenticated;
