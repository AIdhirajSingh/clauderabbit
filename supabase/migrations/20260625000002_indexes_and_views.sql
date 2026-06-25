-- =============================================================================
-- Claude Rabbit — Supplemental Indexes + View Grants
-- Migration: 20260625000002_indexes_and_views.sql
--
-- Adds:
--   - FK indexes missed in the initial migration (report_id on scans,
--     owner_id on reports) — all FKs must be indexed, no exceptions.
--   - Explicit GRANT on the two public views to anon + authenticated.
--   - Grant EXECUTE on check_and_increment_scan_limit to service_role only,
--     confirming no client path can call it directly.
--
-- These are additive-only changes; nothing is dropped or altered.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- FK index: scans.report_id
-- Used by ON DELETE SET NULL cascade lookups and by the edge function that
-- links a finished report back to its scan row.
-- ---------------------------------------------------------------------------
create index if not exists idx_scans_report_id
  on public.scans (report_id)
  where report_id is not null;

-- ---------------------------------------------------------------------------
-- FK index: reports.owner_id
-- Used by joins from reports to owners (e.g. reputation enrichment queries).
-- ---------------------------------------------------------------------------
create index if not exists idx_reports_owner_id
  on public.reports (owner_id)
  where owner_id is not null;

-- ---------------------------------------------------------------------------
-- View grants — belt-and-suspenders (views inherit the table-level RLS of
-- their base tables, but explicit grants ensure the PostgREST API exposes them)
-- ---------------------------------------------------------------------------
grant select on public.v_activity    to anon, authenticated;
grant select on public.v_leaderboard to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Table grant: scans own-history read for authenticated users.
-- The scans_own_read RLS policy (authenticated, auth.uid() = user_id) is
-- unreachable without a table-level SELECT grant — RLS narrows rows but a
-- missing GRANT denies the table outright. This grant makes the policy
-- effective; RLS still restricts rows to the user's own scans. anon is NOT
-- granted (the free first scan has no session and no own-history surface).
-- ---------------------------------------------------------------------------
grant select on public.scans to authenticated;

-- ---------------------------------------------------------------------------
-- Confirm service_role can call the limit function; no one else can.
-- (The revoke was issued in the first migration; this grant is the counterpart.)
-- ---------------------------------------------------------------------------
grant execute on function public.check_and_increment_scan_limit(uuid, text, text)
  to service_role;
