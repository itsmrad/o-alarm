-- Server-managed sync columns: version, updated_at, immutability, soft delete, pull index.
begin;
select plan(11);

insert into public.users (id) values ('user_a');
insert into public.alarms (id, user_id, device_id, hour, minute, created_at, updated_at, version) values
  ('a0000000-0000-0000-0000-000000000001', 'user_a', 'd0000000-0000-0000-0000-00000000000a', 7, 0,
   '2020-01-01 00:00+00', '2020-01-01 00:00+00', 99);   -- client-supplied bookkeeping is overridden

select is((select version from public.alarms), 1::bigint, 'insert resets version to 1');
select ok((select updated_at > now() - interval '1 minute' from public.alarms), 'updated_at is server time, not client-supplied');
select is((select created_at from public.alarms), '2020-01-01 00:00+00'::timestamptz, 'created_at keeps the client value on insert');

create temp table before_update as select updated_at from public.alarms;
update public.alarms set label = 'Gym' where id = 'a0000000-0000-0000-0000-000000000001';
select is((select version from public.alarms), 2::bigint, 'update bumps version');
select ok((select a.updated_at > b.updated_at from public.alarms a, before_update b), 'update advances updated_at');

update public.alarms set created_at = now(), version = 1 where id = 'a0000000-0000-0000-0000-000000000001';
select is((select version from public.alarms), 3::bigint, 'client cannot set version');
select is((select created_at from public.alarms), '2020-01-01 00:00+00'::timestamptz, 'client cannot rewrite created_at');

select throws_ok($$update public.alarms set user_id = 'someone_else'$$, '23514', 'id and user_id are immutable', 'user_id is immutable');
select throws_ok($$update public.alarms set id = gen_random_uuid()$$, '23514', 'id and user_id are immutable', 'id is immutable');

update public.alarms set deleted_at = now() where id = 'a0000000-0000-0000-0000-000000000001';
select is((select count(*)::int from public.alarms where deleted_at is not null), 1, 'soft delete keeps the tombstone row');

select ok(exists (select 1 from pg_indexes where schemaname = 'public' and tablename = 'alarms'
                   and indexdef like '%(user_id, updated_at)%'), 'alarms has the (user_id, updated_at) sync-pull index');

select * from finish();
rollback;
