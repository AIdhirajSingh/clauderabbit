-- Reverse of 20261021000001_v2_ui_user_board.sql (touches schema v2 only)
drop trigger if exists reports_board_broadcast on v2.reports;
drop function if exists v2.reports_board_broadcast();
drop table if exists v2.user_scans;
drop index if exists v2.idx_v2_scan_runs_user;
alter table v2.scan_runs drop column if exists user_id;
