-- ClaudeRabbit 2.0: reports written by the single run path (DESIGN.md section 7.3).
-- scan_path gains 'run'; reports gain run_id, score_breakdown and not_verified.
-- Reverse path: supabase/migrations-down/20261016000002_reports_run_path.down.sql

alter table public.reports drop constraint if exists reports_scan_path_check;
alter table public.reports add constraint reports_scan_path_check
  check (scan_path = any (array['cache', 'fast', 'deep', 'deep-static', 'run']));
alter table public.scans drop constraint if exists scans_scan_path_check;
alter table public.scans add constraint scans_scan_path_check
  check (scan_path = any (array['cache', 'fast', 'deep', 'deep-static', 'run']));

alter table public.reports
  add column if not exists run_id          uuid,
  add column if not exists score_breakdown jsonb,
  add column if not exists not_verified    jsonb;

create index if not exists idx_reports_run_id on public.reports (run_id) where run_id is not null;
