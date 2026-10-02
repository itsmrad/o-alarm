-- Analytics views. security_invoker = true: they run with the caller's privileges, so RLS on the
-- underlying tables scopes every row to the caller; there is no extra filtering to get wrong.
-- Deterministic stats only (docs/PRODUCT.md: AI explains, it does not calculate). Tombstoned rows are
-- ignored. Weeks are ISO weeks (Monday start) of the user's local_date, not of a UTC timestamp.
--
-- "Wake success": an occurrence that rang and ended `dismissed`, and whose wake session (if any) ended
-- `success` (wake check passed / user confirmed awake). Occurrences that are skipped, cancelled,
-- still pending, or whose session is still active are not counted. Ratios are 0..1.

create view public.analytics_wake_success_weekly with (security_invoker = true) as
select
  o.user_id,
  date_trunc('week', o.local_date)::date as week_start,
  count(*)                                                          as alarms_counted,
  count(*) filter (where o.outcome = 'dismissed'
                     and coalesce(ws.status, 'success') = 'success') as successful_wakes,
  round(
    (count(*) filter (where o.outcome = 'dismissed' and coalesce(ws.status, 'success') = 'success'))::numeric
    / count(*), 3)                                                  as success_rate
from public.alarm_occurrences o
left join public.wake_sessions ws
  on ws.alarm_occurrence_id = o.id and ws.deleted_at is null
where o.deleted_at is null
  and o.outcome in ('dismissed', 'missed')
  and coalesce(ws.status, '') <> 'active'
group by o.user_id, date_trunc('week', o.local_date);

create view public.analytics_avg_snoozes_weekly with (security_invoker = true) as
select
  o.user_id,
  date_trunc('week', o.local_date)::date                    as week_start,
  count(*)                                                  as alarms_rang,
  round(avg(o.snooze_count), 2)                             as avg_snoozes,
  count(*) filter (where o.snooze_count > 0)                as alarms_snoozed
from public.alarm_occurrences o
where o.deleted_at is null
  and o.triggered_at is not null
  and o.outcome in ('dismissed', 'missed')
group by o.user_id, date_trunc('week', o.local_date);

-- Dismissal-mission effectiveness per mission type: how often the mission gets completed, and how
-- often wake sessions that used it end in success.
create view public.analytics_mission_effectiveness with (security_invoker = true) as
select
  ma.user_id,
  ma.mission_type,
  count(*)                                                                as attempts,
  count(*) filter (where ma.outcome = 'completed')                        as completed,
  round((count(*) filter (where ma.outcome = 'completed'))::numeric / count(*), 3) as completion_rate,
  round((avg(extract(epoch from ma.ended_at - ma.started_at))
          filter (where ma.outcome = 'completed'))::numeric, 1)            as avg_completion_seconds,
  count(distinct ma.wake_session_id)                                      as sessions,
  count(distinct ma.wake_session_id) filter (where ws.status = 'success') as successful_sessions,
  round((count(distinct ma.wake_session_id) filter (where ws.status = 'success'))::numeric
        / count(distinct ma.wake_session_id), 3)                          as session_success_rate
from public.mission_attempts ma
join public.wake_sessions ws
  on ws.id = ma.wake_session_id and ws.deleted_at is null and ws.status <> 'active'
where ma.deleted_at is null
  and ma.purpose = 'dismiss'
  and ma.outcome <> 'in_progress'
group by ma.user_id, ma.mission_type;

-- Same, per chain ("math > steps"): the ordered mission types of a wake session (latest attempt per
-- chain position, so retries do not lengthen the chain).
create view public.analytics_mission_chain_effectiveness with (security_invoker = true) as
with chains as (
  select
    la.user_id,
    la.wake_session_id,
    string_agg(la.mission_type, ' > ' order by la.position) as chain,
    count(*)                                                as chain_length
  from (
    select distinct on (ma.wake_session_id, ma.position)
      ma.user_id, ma.wake_session_id, ma.position, ma.mission_type
    from public.mission_attempts ma
    where ma.deleted_at is null and ma.purpose = 'dismiss'
    order by ma.wake_session_id, ma.position, ma.started_at desc
  ) la
  group by la.user_id, la.wake_session_id
)
select
  c.user_id,
  c.chain,
  c.chain_length,
  count(*)                                                    as sessions,
  count(*) filter (where ws.status = 'success')               as successful_sessions,
  round((count(*) filter (where ws.status = 'success'))::numeric / count(*), 3) as success_rate,
  round(avg(ws.retrigger_count), 2)                           as avg_retriggers
from chains c
join public.wake_sessions ws
  on ws.id = c.wake_session_id and ws.deleted_at is null and ws.status <> 'active'
group by c.user_id, c.chain, c.chain_length;

-- Wake Check failure rate per week (failed or no response, out of answered/expired checks).
create view public.analytics_wake_check_failure_weekly with (security_invoker = true) as
select
  wc.user_id,
  date_trunc('week', o.local_date)::date                                   as week_start,
  count(*)                                                                 as checks,
  count(*) filter (where wc.outcome in ('failed', 'no_response'))          as failed_checks,
  round((count(*) filter (where wc.outcome in ('failed', 'no_response')))::numeric / count(*), 3) as failure_rate
from public.wake_checks wc
join public.wake_sessions ws on ws.id = wc.wake_session_id and ws.deleted_at is null
join public.alarm_occurrences o on o.id = ws.alarm_occurrence_id and o.deleted_at is null
where wc.deleted_at is null
  and wc.outcome <> 'pending'
group by wc.user_id, date_trunc('week', o.local_date);

-- Which weekdays are hard (ISO weekday: 1 = Monday .. 7 = Sunday).
create view public.analytics_weekday_difficulty with (security_invoker = true) as
select
  o.user_id,
  extract(isodow from o.local_date)::smallint                               as iso_weekday,
  count(*)                                                                  as alarms_counted,
  round((count(*) filter (where o.outcome = 'dismissed'
                            and coalesce(ws.status, 'success') = 'success'))::numeric / count(*), 3) as success_rate,
  round(avg(o.snooze_count), 2)                                             as avg_snoozes,
  round(avg(ws.retrigger_count), 2)                                         as avg_retriggers,
  round((avg(extract(epoch from o.dismissed_at - o.triggered_at)))::numeric, 1) as avg_seconds_to_dismiss
from public.alarm_occurrences o
left join public.wake_sessions ws
  on ws.alarm_occurrence_id = o.id and ws.deleted_at is null
where o.deleted_at is null
  and o.outcome in ('dismissed', 'missed')
  and coalesce(ws.status, '') <> 'active'
group by o.user_id, extract(isodow from o.local_date);

-- Night sleep duration bucket vs next-morning energy / sleep quality. Correlation, not causation.
create view public.analytics_sleep_vs_energy with (security_invoker = true) as
with nightly as (
  select s.user_id, s.local_date, sum(s.duration_minutes) as sleep_minutes
  from public.sleep_sessions s
  where s.deleted_at is null and s.kind = 'night' and s.ended_at is not null
  group by s.user_id, s.local_date
)
select
  n.user_id,
  case when n.sleep_minutes < 360 then 1 when n.sleep_minutes < 420 then 2
       when n.sleep_minutes < 480 then 3 else 4 end::smallint               as bucket_order,
  case when n.sleep_minutes < 360 then '<6h' when n.sleep_minutes < 420 then '6-7h'
       when n.sleep_minutes < 480 then '7-8h' else '8h+' end                as sleep_bucket,
  count(*)                                                                  as nights,
  round((avg(n.sleep_minutes) / 60.0)::numeric, 2)                          as avg_sleep_hours,
  round(avg(c.energy), 2)                                                   as avg_energy,
  round(avg(c.sleep_quality), 2)                                            as avg_sleep_quality
from nightly n
join public.morning_checkins c
  on c.user_id = n.user_id and c.local_date = n.local_date and c.deleted_at is null
group by n.user_id, 2, 3;

grant select on
  public.analytics_wake_success_weekly,
  public.analytics_avg_snoozes_weekly,
  public.analytics_mission_effectiveness,
  public.analytics_mission_chain_effectiveness,
  public.analytics_wake_check_failure_weekly,
  public.analytics_weekday_difficulty,
  public.analytics_sleep_vs_energy
to authenticated;
revoke all on
  public.analytics_wake_success_weekly,
  public.analytics_avg_snoozes_weekly,
  public.analytics_mission_effectiveness,
  public.analytics_mission_chain_effectiveness,
  public.analytics_wake_check_failure_weekly,
  public.analytics_weekday_difficulty,
  public.analytics_sleep_vs_energy
from anon;
