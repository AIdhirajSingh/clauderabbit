-- Reverse of 20261021000003_v2_drop_exports.sql (schema v2 only): recreates
-- v2.exports exactly as 20261021000002_v2_exports.sql created it. The rows are
-- not restored; the table was only dropped while empty.

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
