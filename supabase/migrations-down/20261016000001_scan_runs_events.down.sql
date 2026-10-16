-- Reverse of 20261016000001_scan_runs_events.sql
drop trigger if exists scan_events_broadcast on public.scan_events;
drop table if exists public.scan_events;
drop table if exists public.scan_runs;
drop function if exists public.scan_events_broadcast();
drop function if exists public.expire_stale_runs();
