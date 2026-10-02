-- Expected-vs-observed alarm execution and the wake flow:
-- alarm_occurrences -> wake_sessions -> mission_attempts / wake_checks, plus the mission catalog.
--
-- Natural keys (alarm_occurrences.occurrence_key, wake_sessions.alarm_occurrence_id, ...) are unique so
-- reconciliation/retries cannot double-count. Clients should derive the row `id` deterministically
-- from the natural key (uuid v5) so two devices converge on one row instead of hitting a unique error.

-- Mission catalog: global reference data, readable by signed-in users, writable only via migrations /
-- service role. New mission types are added by migration (keeps the type FK strict and the system
-- extensible without a plugin framework). `tier` mirrors Free vs Pro in docs/PRODUCT.md.
create table public.missions (
  type           text primary key check (type ~ '^[a-z][a-z0-9_]*$'),
  display_name   text not null,
  tier           text not null check (tier in ('free', 'pro')),
  is_available   boolean not null default false,   -- false = planned, not shipped
  sort_order     smallint not null default 0,
  default_config jsonb not null default '{}' check (jsonb_typeof(default_config) = 'object'),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create trigger missions_set_updated_at before update on public.missions
  for each row execute function public.set_updated_at();

insert into public.missions (type, display_name, tier, is_available, sort_order) values
  ('math',    'Math',               'free', true,  10),
  ('shake',   'Shake',              'free', true,  20),
  ('steps',   'Steps / movement',   'free', true,  30),
  ('qr',      'QR / barcode',       'pro',  true,  40),
  ('memory',  'Memory',             'pro',  false, 100),
  ('typing',  'Typing',             'pro',  false, 110),
  ('squats',  'Squats',             'pro',  false, 120),
  ('nfc',     'NFC tag',            'pro',  false, 130),
  ('photo',   'Photo verification', 'pro',  false, 140),
  ('voice',   'Read aloud',         'pro',  false, 150);

-- One row per planned ring. `expected_at` is what the alarm should do; triggered_at / dismissed_at /
-- snooze_count / outcome are what was observed.
create table public.alarm_occurrences (
  id                  uuid primary key,
  user_id             text not null references public.users (id) on delete cascade,
  device_id           uuid not null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  version             bigint not null default 1,
  deleted_at          timestamptz,
  alarm_id            uuid not null,
  occurrence_key      text not null check (length(occurrence_key) between 1 and 200),  -- stable per (alarm, intended fire) - D10
  local_date          date not null,          -- calendar date the user lives the alarm on (weekday analytics)
  expected_at         timestamptz not null,
  native_scheduled_at timestamptz,            -- native schedule verified (D11)
  schedule_status     text not null default 'pending'
                        check (schedule_status in ('pending', 'scheduled', 'failed', 'skipped', 'cancelled')),
  schedule_error      text check (length(schedule_error) <= 500),
  triggered_at        timestamptz,            -- alarm_trigger_received
  dismissed_at        timestamptz,
  snooze_count        smallint not null default 0 check (snooze_count >= 0),
  outcome             text not null default 'pending'
                        check (outcome in ('pending', 'dismissed', 'missed', 'skipped', 'cancelled', 'schedule_failed')),
  constraint alarm_occurrences_dismiss_order check (dismissed_at is null or triggered_at is null or dismissed_at >= triggered_at),
  constraint alarm_occurrences_dismissed_has_time check (outcome <> 'dismissed' or dismissed_at is not null),
  constraint alarm_occurrences_alarm_fk foreign key (alarm_id, user_id)
    references public.alarms (id, user_id) on delete cascade deferrable initially deferred,
  unique (id, user_id),
  unique (user_id, alarm_id, occurrence_key)
);

-- The ring -> confirmed-awake flow for one occurrence (retriggers stay inside the same session).
create table public.wake_sessions (
  id                  uuid primary key,
  user_id             text not null references public.users (id) on delete cascade,
  device_id           uuid not null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  version             bigint not null default 1,
  deleted_at          timestamptz,
  alarm_occurrence_id uuid not null,
  started_at          timestamptz not null,
  ended_at            timestamptz,
  status              text not null default 'active' check (status in ('active', 'success', 'failed', 'abandoned')),
  retrigger_count     smallint not null default 0 check (retrigger_count >= 0),
  constraint wake_sessions_end_order check (ended_at is null or ended_at >= started_at),
  constraint wake_sessions_finished_has_end check (status = 'active' or ended_at is not null),
  constraint wake_sessions_occurrence_fk foreign key (alarm_occurrence_id, user_id)
    references public.alarm_occurrences (id, user_id) on delete cascade deferrable initially deferred,
  unique (id, user_id),
  unique (alarm_occurrence_id)
);

create table public.mission_attempts (
  id              uuid primary key,
  user_id         text not null references public.users (id) on delete cascade,
  device_id       uuid not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  version         bigint not null default 1,
  deleted_at      timestamptz,
  wake_session_id uuid not null,
  mission_type    text not null references public.missions (type),
  position        smallint not null default 0 check (position >= 0),   -- index within the chain
  purpose         text not null default 'dismiss' check (purpose in ('dismiss', 'snooze', 'wake_check')),
  difficulty      smallint check (difficulty between 1 and 5),
  started_at      timestamptz not null,
  ended_at        timestamptz,
  outcome         text not null default 'in_progress' check (outcome in ('in_progress', 'completed', 'failed', 'abandoned')),
  metrics         jsonb not null default '{}' check (jsonb_typeof(metrics) = 'object' and pg_column_size(metrics) <= 4096),
  constraint mission_attempts_end_order check (ended_at is null or ended_at >= started_at),
  constraint mission_attempts_finished_has_end check (outcome = 'in_progress' or ended_at is not null),
  constraint mission_attempts_session_fk foreign key (wake_session_id, user_id)
    references public.wake_sessions (id, user_id) on delete cascade deferrable initially deferred
);

-- Wake Check: after the dismissal mission, verify the user is really awake after an interval (D13).
create table public.wake_checks (
  id              uuid primary key,
  user_id         text not null references public.users (id) on delete cascade,
  device_id       uuid not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  version         bigint not null default 1,
  deleted_at      timestamptz,
  wake_session_id uuid not null,
  check_number    smallint not null default 1 check (check_number >= 1),
  method          text not null check (method in ('confirm', 'movement', 'mission')),
  due_at          timestamptz not null,
  responded_at    timestamptz,
  outcome         text not null default 'pending' check (outcome in ('pending', 'passed', 'failed', 'no_response')),
  retriggered     boolean not null default false,   -- failure re-triggered the alarm
  constraint wake_checks_passed_has_response check (outcome <> 'passed' or responded_at is not null),
  constraint wake_checks_session_fk foreign key (wake_session_id, user_id)
    references public.wake_sessions (id, user_id) on delete cascade deferrable initially deferred,
  unique (wake_session_id, check_number)
);
