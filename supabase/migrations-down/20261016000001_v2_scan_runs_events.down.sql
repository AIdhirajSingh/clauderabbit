-- Reverse of 20261016000001_v2_scan_runs_events.sql (touches schema v2 only)
drop table if exists v2.scan_events;
drop table if exists v2.scan_runs;
drop table if exists v2.reports;
drop table if exists v2.owners;
drop function if exists v2.scan_events_broadcast();
drop function if exists v2.expire_stale_runs();
