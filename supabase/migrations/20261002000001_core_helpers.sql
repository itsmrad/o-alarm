-- Core helpers shared by every table.
--
-- Privilege model (docs/DECISIONS.md D16): the `anon` role never touches application data.
-- Supabase grants new public tables to anon/authenticated by default; turn that off so that every
-- table has to be granted explicitly (see 20261002000006_sync_rls_policies.sql).

alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke all on sequences from anon;
alter default privileges in schema public revoke execute on functions from anon, public;

-- users.updated_at only (users is not a sync-pulled table).
create function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := clock_timestamp();
  return new;
end;
$$;

-- Sync bookkeeping for every syncable table. The server owns `version` and `updated_at`:
--   * updated_at must come from one clock, otherwise a device with a skewed clock writes rows that
--     other devices' `updated_at > cursor` pulls never see. clock_timestamp() (not now()) so a long
--     transaction cannot stamp a row with a time earlier than rows other transactions already committed.
--   * version is a per-row counter (1 on insert, +1 on every update) usable for optimistic checks.
-- Conflict policy (D17) is last-writer-wins per row: the latest accepted write replaces the row.
create function public.sync_touch()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.version := 1;
  else
    if new.id is distinct from old.id or new.user_id is distinct from old.user_id then
      raise exception 'id and user_id are immutable' using errcode = '23514';
    end if;
    new.created_at := old.created_at;
    new.version := old.version + 1;
  end if;
  new.updated_at := clock_timestamp();
  return new;
end;
$$;

-- Append-only guard (events).
create function public.forbid_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception '% is append-only', tg_table_name using errcode = '55000';
end;
$$;

revoke execute on function public.set_updated_at(), public.sync_touch(), public.forbid_update()
  from public, anon, authenticated;
