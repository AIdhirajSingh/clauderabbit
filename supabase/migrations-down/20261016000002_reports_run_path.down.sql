-- Reverse of 20261016000002_reports_run_path.sql
-- Rows written by the run path always ran the code in the sandbox (deep = true),
-- so they map onto the prior 'deep' value before the old check is restored.
drop index if exists public.idx_reports_run_id;
alter table public.reports drop column if exists not_verified;
alter table public.reports drop column if exists score_breakdown;
alter table public.reports drop column if exists run_id;

alter table public.reports drop constraint if exists reports_scan_path_check;
update public.reports set scan_path = 'deep' where scan_path = 'run';
alter table public.reports add constraint reports_scan_path_check
  check (scan_path = any (array['cache', 'fast', 'deep', 'deep-static']));
alter table public.scans drop constraint if exists scans_scan_path_check;
update public.scans set scan_path = 'deep' where scan_path = 'run';
alter table public.scans add constraint scans_scan_path_check
  check (scan_path = any (array['cache', 'fast', 'deep', 'deep-static']));
