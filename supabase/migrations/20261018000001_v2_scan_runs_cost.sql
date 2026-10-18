-- ClaudeRabbit 2.0: per-run cost ledger on v2.scan_runs (additive, schema v2 only).
--
-- One jsonb per finished run (lib/engine/cost.ts CostLedger, version 1): Jev
-- tokens (input, output, cached) at the AI Gateway price, Luna tokens (input,
-- output, cached, cache writes) at the OpenAI price, E2B sandbox seconds at the
-- template's per-second price, and the total in USD and INR with the rate's
-- source and date. Null on runs that ended in error and on runs written before
-- this column. The existing grants on v2.scan_runs (select, insert, update to
-- cr_v2_server) and its RLS policy cover the new column.
-- Reverse path: supabase/migrations-down/20261018000001_v2_scan_runs_cost.down.sql

alter table v2.scan_runs add column cost jsonb;
