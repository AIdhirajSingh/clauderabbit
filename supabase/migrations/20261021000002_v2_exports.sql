-- ClaudeRabbit 2.0: MP4 export state per scan run, and the private bucket the
-- MP4s live in. Touches schema v2 and creates one new storage bucket
-- (v2-exports); no 1.0 object is altered.
--
-- cr_v2_server is NOBYPASSRLS, so it reaches the table through one policy
-- scoped to that role only (the pattern of 20261016000001_v2_scan_runs_events.sql);
-- anon and authenticated hold no grant and no policy.
--
-- Reverse path: supabase/migrations-down/20261021000002_v2_exports.down.sql

create table if not exists v2.exports (
  run_id     uuid        primary key references v2.scan_runs (id) on delete cascade,
  status     text        not null default 'rendering' check (status in ('rendering', 'done', 'error')),
  progress   int         not null default 0 check (progress between 0 and 100),
  bytes      int,
  seconds    numeric(8, 3),
  render_ms  int,
  cost_inr   numeric(12, 6),
  error      text,
  updated_at timestamptz not null default now()
);

create trigger exports_touch_updated_at
  before update on v2.exports
  for each row execute function v2.touch_updated_at();

alter table v2.exports enable row level security;
create policy exports_server_all on v2.exports for all to cr_v2_server using (true) with check (true);
revoke all on v2.exports from public, anon, authenticated;
grant select, insert, update on v2.exports to cr_v2_server;

insert into storage.buckets (id, name, public)
values ('v2-exports', 'v2-exports', false)
on conflict (id) do nothing;
