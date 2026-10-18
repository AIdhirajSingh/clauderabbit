-- Reverse of 20261018000001_v2_scan_runs_cost.sql (touches schema v2 only)
alter table v2.scan_runs drop column if exists cost;
