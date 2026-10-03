-- Every public table has RLS on, anon has no access to tables, views or functions.
begin;
select plan(8);

select is(
  (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity),
  0, 'RLS is enabled on every public table');

select is(
  (select count(*)::int from information_schema.role_table_grants
    where table_schema = 'public' and grantee in ('anon', 'PUBLIC')),
  0, 'anon/PUBLIC hold no table or view privilege in public');

select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute')),
  0, 'anon cannot execute any function in public');

select is(
  (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'v'
      and not coalesce((select 'security_invoker=true' = any (c.reloptions)), false)),
  0, 'every public view is security_invoker');

-- Behavioural checks as anon.
insert into public.users (id) values ('anon_victim');
set local role anon;
select throws_ok($$select * from public.alarms$$, '42501', null, 'anon cannot select alarms');
select throws_ok($$select * from public.users$$, '42501', null, 'anon cannot select users');
select throws_ok($$insert into public.users (id) values ('x')$$, '42501', null, 'anon cannot insert');
select throws_ok($$select * from public.analytics_weekday_difficulty$$, '42501', null, 'anon cannot read analytics views');

select * from finish();
rollback;
