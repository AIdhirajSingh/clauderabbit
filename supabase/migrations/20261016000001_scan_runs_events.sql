-- ClaudeRabbit 2.0: one run per scan, one ordered event log per run (DESIGN.md sections 6, 7.1).
--
-- scan_runs   one row per scan attempt. A partial unique index allows only one
--             'running' row per (subject, commit_sha), which is the dedup that
--             lets a second request attach to the first instead of starting a
--             second sandbox.
-- scan_events the event stream of a run (stage, timing, transcript, forged_call,
--             file, process, check), ordered by seq. Each inserted row is
--             broadcast on Realtime topic 'scan:<run_id>' (public channel, event
--             name = type) and stays stored for replay per SHA.
-- Reverse path: supabase/migrations-down/20261016000001_scan_runs_events.down.sql

create table public.scan_runs (
  id           uuid        primary key default gen_random_uuid(),
  target_kind  text        not null check (target_kind in ('github', 'npm', 'tarball')),
  subject      text        not null,
  commit_sha   text        not null,
  status       text        not null default 'running' check (status in ('running', 'done', 'error')),
  error_code   text,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  timings      jsonb,
  report_id    bigint      references public.reports (id) on delete set null,
  model_id     text,
  template     text
);

create unique index uq_scan_runs_running
  on public.scan_runs (subject, commit_sha)
  where status = 'running';

create index idx_scan_runs_done
  on public.scan_runs (subject, commit_sha, finished_at desc)
  where status = 'done';

create table public.scan_events (
  run_id  uuid    not null references public.scan_runs (id) on delete cascade,
  seq     integer not null check (seq >= 0),
  t_ms    integer not null check (t_ms >= 0),
  type    text    not null check (type in ('stage', 'timing', 'transcript', 'forged_call', 'file', 'process', 'check')),
  data    jsonb   not null,
  primary key (run_id, seq)
);

-- Realtime fan-out: every stored event is broadcast on 'scan:<run_id>'.
create or replace function public.scan_events_broadcast()
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

create trigger scan_events_broadcast
  after insert on public.scan_events
  for each row execute function public.scan_events_broadcast();

-- A run that has been 'running' for over five minutes is past every deadline
-- (scan deadline 75 s, sandbox timeout 90 s); mark it so the dedup index frees.
create or replace function public.expire_stale_runs()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  update public.scan_runs
     set status = 'error', error_code = 'stale', finished_at = now()
   where status = 'running'
     and started_at < now() - interval '5 minutes';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke execute on function public.expire_stale_runs() from public, anon, authenticated;
grant  execute on function public.expire_stale_runs() to service_role;
revoke execute on function public.scan_events_broadcast() from public, anon, authenticated;

alter table public.scan_runs   enable row level security;
alter table public.scan_events enable row level security;

create policy "scan_runs_public_read"   on public.scan_runs   for select to anon, authenticated using (true);
create policy "scan_runs_service_all"   on public.scan_runs   for all    to service_role using (true) with check (true);
create policy "scan_events_public_read" on public.scan_events for select to anon, authenticated using (true);
create policy "scan_events_service_all" on public.scan_events for all    to service_role using (true) with check (true);

grant select on public.scan_runs   to anon, authenticated;
grant select on public.scan_events to anon, authenticated;
grant all    on public.scan_runs   to service_role;
grant all    on public.scan_events to service_role;
