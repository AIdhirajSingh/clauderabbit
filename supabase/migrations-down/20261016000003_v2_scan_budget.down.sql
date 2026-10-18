-- Reverse of 20261016000003_v2_scan_budget.sql (touches schema v2 only)
drop function if exists v2.scan_budget_charge(integer, integer, integer, integer);
drop table if exists v2.scan_budget;
