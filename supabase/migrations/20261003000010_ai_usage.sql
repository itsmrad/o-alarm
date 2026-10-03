-- AI insights rate limit (D19 cost guard): one row per accepted LLM request, written only by the
-- `ai-insights` Edge Function (service role) through claim_ai_quota(). Rolling 7-day window per user
-- and bucket (weekly_report: 1, explanation: 10; limits live in the function). Clients have no access.

create table public.ai_usage (
  id         uuid primary key default gen_random_uuid(),
  user_id    text not null references public.users (id) on delete cascade,
  bucket     text not null check (bucket in ('weekly_report', 'explanation')),
  created_at timestamptz not null default now()
);
create index ai_usage_user_bucket_idx on public.ai_usage (user_id, bucket, created_at);

alter table public.ai_usage enable row level security;
revoke all on public.ai_usage from anon, authenticated;
grant select, insert, delete on public.ai_usage to service_role;

-- Records one use when the caller is under p_limit in the last 7 days. Returns the claim id, or null
-- when the limit is reached. Serialized per user so concurrent requests cannot both pass the check.
create function public.claim_ai_quota(p_user_id text, p_bucket text, p_limit integer)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_user_id is null or p_limit is null or p_limit < 0 then
    raise exception 'invalid quota claim' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext('ai_usage:' || p_user_id));
  if (select count(*) from public.ai_usage u
        where u.user_id = p_user_id and u.bucket = p_bucket
          and u.created_at > now() - interval '7 days') >= p_limit then
    return null;
  end if;
  insert into public.ai_usage (user_id, bucket) values (p_user_id, p_bucket) returning id into v_id;
  return v_id;
end;
$$;

revoke all on function public.claim_ai_quota(text, text, integer) from public, anon, authenticated;
grant execute on function public.claim_ai_quota(text, text, integer) to service_role;

-- ai_usage is user-owned: export and delete must cover it.
create or replace function public.user_data_tables()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array[
    'devices', 'alarms', 'alarm_occurrences', 'wake_sessions', 'mission_attempts', 'wake_checks',
    'sleep_sessions', 'morning_checkins', 'preferences', 'sync_state',
    'ai_insights', 'entitlements', 'data_export_requests', 'events', 'guest_migrations', 'ai_usage'
  ]
$$;
