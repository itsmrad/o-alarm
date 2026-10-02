-- AI insights, entitlements, sync state, events, data export requests.

-- Written only by Edge Functions (service role): pipeline events -> stats -> structured insight -> LLM
-- explanation (docs/PRODUCT.md). Clients can read, never write.
create table public.ai_insights (
  id             uuid primary key default gen_random_uuid(),
  user_id        text not null references public.users (id) on delete cascade,
  device_id      uuid,                                   -- unused: no device writes this table
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  version        bigint not null default 1,
  deleted_at     timestamptz,
  type           text not null check (type in ('bedtime_recommendation', 'wake_pattern', 'mission_recommendation', 'weekly_report')),
  period_start   date not null,
  period_end     date not null,
  schema_version smallint not null default 1,
  structured     jsonb not null check (jsonb_typeof(structured) = 'object'),   -- deterministic stats / validated LLM JSON
  explanation    text,                                                          -- LLM prose
  model          text,                                                          -- e.g. OpenRouter model slug; null if deterministic-only
  constraint ai_insights_period_order check (period_end >= period_start),
  unique (user_id, type, period_start, period_end)
);

-- Mirror of RevenueCat state, written by the RevenueCat webhook Edge Function (service role). The client
-- only reads it as a cache; the RevenueCat SDK stays the client's primary source (D18). The webhook must
-- upsert public.users first (the FK) because a purchase can precede the user's first sync.
create table public.entitlements (
  id                  uuid primary key default gen_random_uuid(),
  user_id             text not null references public.users (id) on delete cascade,
  device_id           uuid,                              -- unused: no device writes this table
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  version             bigint not null default 1,
  deleted_at          timestamptz,
  entitlement         text not null default 'pro',
  is_active           boolean not null default false,
  product_id          text,
  store               text check (store in ('app_store', 'play_store', 'stripe', 'promotional')),
  environment         text not null default 'production' check (environment in ('production', 'sandbox')),
  period_type         text check (period_type in ('trial', 'intro', 'normal')),
  will_renew          boolean,
  original_purchase_at timestamptz,
  expires_at          timestamptz,
  latest_event_at     timestamptz,                       -- RevenueCat event_timestamp; drop out-of-order webhooks
  unique (user_id, entitlement)
);

-- Per-device sync bookkeeping + the one-time guest -> account migration marker (D17).
create table public.sync_state (
  id                  uuid primary key,
  user_id             text not null references public.users (id) on delete cascade,
  device_id           uuid not null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  version             bigint not null default 1,
  deleted_at          timestamptz,
  last_pushed_at      timestamptz,
  last_pulled_at      timestamptz,
  pull_cursor         timestamptz,                       -- greatest server updated_at seen
  guest_migrated_at   timestamptz,
  schema_version      smallint,
  last_error          text check (length(last_error) <= 500),
  unique (user_id, device_id)
);

-- Append-only analytics/reliability log (D12). Only the PRODUCT.md key events are accepted. No
-- updated_at/version/deleted_at: rows are never modified or tombstoned (only deleted wholesale by
-- delete_my_data()). `properties` must not carry raw sleep data.
create table public.events (
  id          uuid primary key,
  user_id     text not null references public.users (id) on delete cascade,
  device_id   uuid not null,
  created_at  timestamptz not null default now(),
  name        text not null check (name in (
    'alarm_created', 'alarm_updated', 'alarm_native_scheduled', 'alarm_schedule_failed',
    'alarm_expected', 'alarm_trigger_received', 'alarm_snoozed', 'alarm_dismissed',
    'mission_started', 'mission_completed', 'mission_failed',
    'wake_check_started', 'wake_check_passed', 'wake_check_failed', 'alarm_retriggered'
  )),
  occurred_at timestamptz not null,
  alarm_id    uuid,                                      -- no FK: log may arrive before the alarm syncs
  occurrence_id uuid,
  properties  jsonb not null default '{}' check (jsonb_typeof(properties) = 'object' and pg_column_size(properties) <= 4096)
);
create trigger events_forbid_update before update on public.events
  for each row execute function public.forbid_update();

-- Async export jobs (large exports / emailed link); export_my_data() is the synchronous path.
-- Clients create requests; the export Edge Function (service role) fills in the rest.
create table public.data_export_requests (
  id            uuid primary key default gen_random_uuid(),
  user_id       text not null references public.users (id) on delete cascade,
  device_id     uuid,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  version       bigint not null default 1,
  deleted_at    timestamptz,
  status        text not null default 'requested' check (status in ('requested', 'processing', 'ready', 'failed', 'expired')),
  completed_at  timestamptz,
  expires_at    timestamptz,
  storage_path  text,                                    -- private storage object holding the export
  error         text check (length(error) <= 500)
);
