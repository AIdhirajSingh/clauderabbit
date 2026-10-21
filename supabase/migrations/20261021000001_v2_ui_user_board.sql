-- ClaudeRabbit 2.0: signed-in scan history and the live danger board (additive, schema v2 only).
--
-- v2.scan_runs.user_id  the Supabase user id of the signed-in caller that
--                       started the run; null for a guest (shown as
--                       Anonymous). Nothing else about a guest is stored.
-- v2.user_scans         one row per result a signed-in caller received
--                       (fresh, cached or attached to a run another request
--                       started), so a cache hit lands in that user's history
--                       too. The server inserts it; nobody else can reach it.
-- v2.reports_board_broadcast()
--                       after every insert or update of a v2.reports row, a
--                       Realtime Broadcast on the public topic 'board' (event
--                       'report') carrying the board fields only, so the /app
--                       danger board updates live. Reports are public pages;
--                       the payload holds nothing a report page does not show.
--
-- user_id carries no foreign key to auth.users on purpose: a foreign key adds
-- internal triggers to auth.users and takes a lock on it, and no 2.0 migration
-- alters an auth or public object (tests/db/migrations.test.ts checks the auth
-- catalog is identical before and after the 2.0 set). The id is written only by
-- the server, from a verified JWT or CLI token (lib/engine/auth.ts).
--
-- Grants follow 20261016000001: RLS on, one permissive policy for cr_v2_server,
-- table grants to cr_v2_server only, no grant to anon, authenticated or
-- service_role. The existing grants and policy on v2.scan_runs cover user_id.
-- Reverse path: supabase/migrations-down/20261021000001_v2_ui_user_board.down.sql

alter table v2.scan_runs add column user_id uuid null;

create index idx_v2_scan_runs_user
  on v2.scan_runs (user_id, started_at desc)
  where user_id is not null;

create table v2.user_scans (
  user_id    uuid        not null,
  run_id     uuid        not null references v2.scan_runs (id) on delete cascade,
  scanned_at timestamptz not null default now(),
  primary key (user_id, scanned_at, run_id)
);

create index idx_v2_user_scans_run on v2.user_scans (run_id);

alter table v2.user_scans enable row level security;

create policy user_scans_server_all on v2.user_scans for all to cr_v2_server using (true) with check (true);

grant select, insert on v2.user_scans to cr_v2_server;

-- Realtime Broadcast fan-out for the board. SECURITY DEFINER so the server role
-- needs no grant on the realtime schema; the function only forwards board fields.
create or replace function v2.reports_board_broadcast()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform realtime.send(
    jsonb_build_object(
      'owner_login', new.owner_login,
      'repo_name',   new.repo_name,
      'commit_sha',  new.commit_sha,
      'score',       new.score,
      'verdict',     new.verdict,
      'run_id',      new.run_id,
      'created_at',  new.created_at,
      'updated_at',  new.updated_at
    ),
    'report',
    'board',
    false
  );
  return new;
end;
$$;

revoke execute on function v2.reports_board_broadcast() from public;

create trigger reports_board_broadcast
  after insert or update on v2.reports
  for each row execute function v2.reports_board_broadcast();
