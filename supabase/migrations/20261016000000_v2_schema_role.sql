-- ClaudeRabbit 2.0: schema `v2` and the 2.0 server login role.
--
-- 2.0 runs in the production project beside the live 1.0 stack. Every 2.0
-- object lives in schema v2; nothing in public, auth, storage or any 1.0
-- object is altered, dropped or written by the 2.0 migrations.
--
-- cr_v2_server is the only credential the 2.0 server (Vercel functions) holds.
-- It logs in through the Supavisor pooler, owns nothing, cannot bypass RLS,
-- cannot create roles or databases, and gets USAGE on schema v2 plus per-table
-- DML grants (in the later v2 migrations). It has no grant on any public table.
-- The password is never in a migration: it is set once with
-- `alter role cr_v2_server password ...` in a single operator SQL call.
--
-- Reverse path: supabase/migrations-down/20261016000000_v2_schema_role.down.sql

create schema if not exists v2;
revoke all on schema v2 from public;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'cr_v2_server') then
    create role cr_v2_server
      login
      noinherit
      nosuperuser
      nocreatedb
      nocreaterole
      noreplication
      nobypassrls
      connection limit 60;
  end if;
end
$$;

-- Session defaults for the role only: every statement fails fast instead of
-- holding a pooled connection, and unqualified names never resolve to public.
alter role cr_v2_server set statement_timeout = '20s';
alter role cr_v2_server set search_path = v2;

grant usage on schema v2 to cr_v2_server;

-- Shared updated_at stamp for v2 tables.
create or replace function v2.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

revoke execute on function v2.touch_updated_at() from public;
