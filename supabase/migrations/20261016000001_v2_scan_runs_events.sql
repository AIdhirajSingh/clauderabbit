-- ClaudeRabbit 2.0: reports, owner cache, runs and the per-run event log, all
-- in schema v2 (DESIGN.md sections 6, 7.1, 7.3).
--
-- v2.owners      GitHub owner reputation cache (TTL refreshed by the engine).
-- v2.reports     one row per (owner_login, repo_name, commit_sha): the report
--                the public pages render. Same column names as the 1.0 reports
--                row, so lib/report-row.ts reshapes either one.
-- v2.scan_runs   one row per scan attempt. A partial unique index allows only
--                one 'running' row per (subject, commit_sha): the dedup that
--                lets a second request attach instead of starting a second VM.
-- v2.scan_events the event stream of a run, ordered by seq. Each inserted row
--                is broadcast through Realtime Broadcast on topic
--                'scan:<run_id>' (public channel, event = type) by a trigger, so
--                no schema has to be exposed to the Data API; rows stay stored
--                for replay per SHA.
-- Reverse path: supabase/migrations-down/20261016000001_v2_scan_runs_events.down.sql

create table v2.owners (
  id                bigint      generated always as identity primary key,
  github_login      text        not null unique,
  display_name      text,
  account_age_label text,
  created_at_github timestamptz,
  established       boolean     not null default false,
  public_repos      integer,
  stars_total       integer,
  sentiment         text,
  sentiment_score   integer     check (sentiment_score between 0 and 100),
  reputation_json   jsonb,
  fetched_at        timestamptz not null default now(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create trigger owners_touch_updated_at
  before update on v2.owners
  for each row execute function v2.touch_updated_at();

create table v2.reports (
  id              bigint       generated always as identity primary key,
  owner_login     text         not null,
  repo_name       text         not null,
  commit_sha      text         not null,
  ref             text,
  score           integer      not null check (score between 0 and 100),
  verdict         text         not null check (verdict in ('No threats observed', 'Low risk', 'Caution', 'High risk', 'Malicious')),
  cached          boolean      not null default false,
  deep            boolean      not null default true,
  summary         text,
  confidence      numeric(4,3) check (confidence between 0 and 1),
  scan_path       text         not null default 'run' check (scan_path = 'run'),
  stats_json      jsonb,
  packages_json   jsonb,
  risky_json      jsonb,
  logs_json       jsonb,
  forensics_json  jsonb,
  run_id          uuid,
  score_breakdown jsonb,
  not_verified    jsonb        not null default '[]'::jsonb,
  created_at      timestamptz  not null default now(),
  updated_at      timestamptz  not null default now(),
  constraint uq_v2_reports_owner_repo_sha unique (owner_login, repo_name, commit_sha)
);

create index idx_v2_reports_owner_repo on v2.reports (owner_login, repo_name, created_at desc);
create index idx_v2_reports_updated on v2.reports (updated_at desc);

create trigger reports_touch_updated_at
  before update on v2.reports
  for each row execute function v2.touch_updated_at();

create table v2.scan_runs (
  id           uuid        primary key default gen_random_uuid(),
  target_kind  text        not null check (target_kind in ('github', 'npm', 'tarball')),
  subject      text        not null,
  commit_sha   text        not null,
  status       text        not null default 'running' check (status in ('running', 'done', 'error')),
  error_code   text,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  timings      jsonb,
  report_id    bigint      references v2.reports (id) on delete set null,
  model_id     text,
  template     text
);

create unique index uq_v2_scan_runs_running
  on v2.scan_runs (subject, commit_sha)
  where status = 'running';

create index idx_v2_scan_runs_done
  on v2.scan_runs (subject, commit_sha, finished_at desc)
  where status = 'done';

create index idx_v2_scan_runs_report on v2.scan_runs (report_id) where report_id is not null;

create table v2.scan_events (
  run_id  uuid    not null references v2.scan_runs (id) on delete cascade,
  seq     integer not null check (seq >= 0),
  t_ms    integer not null check (t_ms >= 0),
  type    text    not null check (type in ('stage', 'timing', 'transcript', 'forged_call', 'file', 'process', 'check')),
  data    jsonb   not null,
  primary key (run_id, seq)
);

-- Realtime Broadcast fan-out. SECURITY DEFINER so the server role needs no
-- grant on the realtime schema; the function only forwards the new row.
create or replace function v2.scan_events_broadcast()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform realtime.send(
    jsonb_build_object('seq', new.seq, 't_ms', new.t_ms, 'data', new.data),
    new.type,
    'scan:' || new.run_id::text,
    false
  );
  return new;
end;
$$;

revoke execute on function v2.scan_events_broadcast() from public;

create trigger scan_events_broadcast
  after insert on v2.scan_events
  for each row execute function v2.scan_events_broadcast();

-- A run that has been 'running' for over five minutes is past every deadline
-- (scan deadline 75 s, sandbox timeout 90 s); mark it so the dedup index frees.
create or replace function v2.expire_stale_runs()
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_count integer;
begin
  update v2.scan_runs
     set status = 'error', error_code = 'stale', finished_at = now()
   where status = 'running'
     and started_at < now() - interval '5 minutes';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke execute on function v2.expire_stale_runs() from public;
grant  execute on function v2.expire_stale_runs() to cr_v2_server;

alter table v2.owners      enable row level security;
alter table v2.reports     enable row level security;
alter table v2.scan_runs   enable row level security;
alter table v2.scan_events enable row level security;

create policy owners_server_all      on v2.owners      for all to cr_v2_server using (true) with check (true);
create policy reports_server_all     on v2.reports     for all to cr_v2_server using (true) with check (true);
create policy scan_runs_server_all   on v2.scan_runs   for all to cr_v2_server using (true) with check (true);
create policy scan_events_server_all on v2.scan_events for all to cr_v2_server using (true) with check (true);

grant select, insert, update on v2.owners      to cr_v2_server;
grant select, insert, update on v2.reports     to cr_v2_server;
grant select, insert, update on v2.scan_runs   to cr_v2_server;
grant select, insert         on v2.scan_events to cr_v2_server;
grant usage, select on all sequences in schema v2 to cr_v2_server;
