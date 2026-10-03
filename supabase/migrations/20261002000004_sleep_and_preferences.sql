-- Sleep history, morning check-ins, preferences.

create table public.sleep_sessions (
  id               uuid primary key,
  user_id          text not null references public.users (id) on delete cascade,
  device_id        uuid not null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  version          bigint not null default 1,
  deleted_at       timestamptz,
  kind             text not null default 'night' check (kind in ('night', 'nap')),
  started_at       timestamptz not null,
  ended_at         timestamptz,
  local_date       date not null,                    -- morning date the sleep belongs to
  source           text not null default 'manual' check (source in ('manual', 'inferred')),
  duration_minutes integer generated always as ((extract(epoch from (ended_at - started_at)) / 60)::integer) stored,
  constraint sleep_sessions_end_after_start check (ended_at is null or ended_at > started_at)
);

create table public.morning_checkins (
  id            uuid primary key,
  user_id       text not null references public.users (id) on delete cascade,
  device_id     uuid not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  version       bigint not null default 1,
  deleted_at    timestamptz,
  local_date    date not null,
  checked_in_at timestamptz not null default now(),
  energy        smallint not null check (energy between 1 and 5),
  sleep_quality smallint not null check (sleep_quality between 1 and 5)
);
-- one check-in per user per day (tombstoned rows don't count)
create unique index morning_checkins_one_per_day on public.morning_checkins (user_id, local_date)
  where deleted_at is null;

-- One row per user. Clients upsert with on_conflict=user_id.
create table public.preferences (
  id                              uuid primary key,
  user_id                         text not null unique references public.users (id) on delete cascade,
  device_id                       uuid not null,
  created_at                      timestamptz not null default now(),
  updated_at                      timestamptz not null default now(),
  version                         bigint not null default 1,
  deleted_at                      timestamptz,
  desired_sleep_minutes           smallint not null default 480 check (desired_sleep_minutes between 240 and 840),
  sleep_latency_minutes           smallint not null default 15 check (sleep_latency_minutes between 0 and 120),
  bedtime_target                  time,
  bedtime_reminder_enabled        boolean not null default false,
  wind_down_reminder_enabled      boolean not null default false,
  wind_down_minutes               smallint not null default 60 check (wind_down_minutes between 5 and 240),
  caffeine_cutoff_enabled         boolean not null default false,
  caffeine_cutoff_hours_before_bed smallint not null default 8 check (caffeine_cutoff_hours_before_bed between 1 and 16),
  morning_light_reminder_enabled  boolean not null default false,
  morning_movement_reminder_enabled boolean not null default false,
  -- consent for sending computed stats to the AI edge function (D19); off by default
  ai_personalization_enabled      boolean not null default false
);
