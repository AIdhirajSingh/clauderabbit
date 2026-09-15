-- The escalated tier can now resolve as a deep behavioural READ on Vertex
-- ('deep-static') as well as a live sandbox run ('deep'). Keeping them as
-- distinct values is the point: 'deep' means the code was executed, and a read
-- must never be recorded under it. is_dynamic stays reserved for a real run.
alter table public.reports drop constraint if exists reports_scan_path_check;
alter table public.reports add constraint reports_scan_path_check
  check (scan_path = any (array['cache','fast','deep','deep-static']));

alter table public.scans drop constraint if exists scans_scan_path_check;
alter table public.scans add constraint scans_scan_path_check
  check (scan_path = any (array['cache','fast','deep','deep-static']));
