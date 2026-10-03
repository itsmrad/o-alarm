-- export_my_data() / delete_my_data(): scoped to the caller, closed to anon.
begin;
select plan(13);

insert into public.users (id) values ('user_a'), ('user_b');
insert into public.alarms (id, user_id, device_id, hour, minute) values
  ('a0000000-0000-0000-0000-00000000000a', 'user_a', 'd0000000-0000-0000-0000-00000000000a', 7, 0),
  ('a0000000-0000-0000-0000-00000000000b', 'user_b', 'd0000000-0000-0000-0000-00000000000b', 6, 0);
insert into public.alarm_occurrences (id, user_id, device_id, alarm_id, occurrence_key, local_date, expected_at) values
  ('0c000000-0000-0000-0000-00000000000a', 'user_a', 'd0000000-0000-0000-0000-00000000000a', 'a0000000-0000-0000-0000-00000000000a', 'k1', '2026-10-05', '2026-10-05 07:00+00');
insert into public.events (id, user_id, device_id, name, occurred_at) values
  ('e7000000-0000-0000-0000-00000000000a', 'user_a', 'd0000000-0000-0000-0000-00000000000a', 'alarm_created', now()),
  ('e7000000-0000-0000-0000-00000000000b', 'user_b', 'd0000000-0000-0000-0000-00000000000b', 'alarm_created', now());
insert into public.entitlements (user_id, is_active) values ('user_a', true), ('user_b', true);

-- Guard: every public table with a user_id column is covered by user_data_tables().
select is(
  (select array_agg(c.table_name::text order by c.table_name) from information_schema.columns c
    join information_schema.tables t using (table_schema, table_name)
    where c.table_schema = 'public' and c.column_name = 'user_id' and t.table_type = 'BASE TABLE'),
  (select array_agg(t order by t) from unnest(public.user_data_tables()) t),
  'user_data_tables() lists every table with a user_id column');

-- Unauthenticated callers.
set local role anon;
select throws_ok($$select public.export_my_data()$$, '42501', null, 'anon cannot call export_my_data');
select throws_ok($$select public.delete_my_data()$$, '42501', null, 'anon cannot call delete_my_data');
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
select throws_ok($$select public.export_my_data()$$, '28000', 'not authenticated', 'export needs a sub claim');
select throws_ok($$select public.delete_my_data()$$, '28000', 'not authenticated', 'delete needs a sub claim');

-- Export is scoped to the caller.
select set_config('request.jwt.claims', '{"sub":"user_a","role":"authenticated"}', true);
select is((select public.export_my_data()->>'user_id'), 'user_a', 'export reports the caller');
select is((select jsonb_array_length(public.export_my_data()->'tables'->'alarms')), 1, 'export contains the caller''s alarms');
select is((select public.export_my_data()->'tables'->'alarms'->0->>'id'), 'a0000000-0000-0000-0000-00000000000a', 'export contains only the caller''s rows');
select is((select jsonb_array_length(public.export_my_data()->'tables'->'events')), 1, 'export includes events');

-- Delete is scoped to the caller and removes everything they own.
select is((select public.delete_my_data()->>'alarms'), '1', 'delete reports rows removed per table');
select is((select count(*)::int from public.users), 0, 'caller''s users row is gone (user_b invisible through RLS)');
reset role;
select is(
  (select (select count(*) from public.users where id = 'user_a')
        + (select count(*) from public.alarms where user_id = 'user_a')
        + (select count(*) from public.alarm_occurrences where user_id = 'user_a')
        + (select count(*) from public.events where user_id = 'user_a')
        + (select count(*) from public.entitlements where user_id = 'user_a')),
  0::bigint, 'nothing of user_a remains (cascade, incl. events and entitlements)');
select is(
  (select (select count(*) from public.alarms where user_id = 'user_b')
        + (select count(*) from public.events where user_id = 'user_b')
        + (select count(*) from public.entitlements where user_id = 'user_b')),
  3::bigint, 'user_b''s data is untouched');

select * from finish();
rollback;
