-- Reverse of 20261022000001_v2_scan_economics.sql. Touches schema v2 only.
drop view if exists v2.scan_economics;
drop table if exists v2.ad_settings;
alter table v2.scan_runs drop column if exists ads_last_at;
alter table v2.scan_runs drop column if exists ads_shown;
