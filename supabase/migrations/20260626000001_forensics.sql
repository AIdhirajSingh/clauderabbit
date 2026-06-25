-- =============================================================================
-- Claude Rabbit — Forensics column for deep (dynamic sandbox) reports
-- Migration: 20260626000001_forensics.sql
--
-- The monitored-sinkhole dynamic engine emits a structured forensic record per
-- deep run (what it ran, captured network intent + intended IPs + geolocation,
-- attempted-exfil payloads captured INERT, in-VM behavior, the verdict, and an
-- honest not_verified list). This migration adds a place to persist that record
-- on the report row, and a service-role-only function to write it.
--
-- Scope: ADDITIVE only. Touches ONLY the reports table (adds one column) and
-- adds one new function. It does NOT alter or re-run prior migrations.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. forensics_json column on reports
--    Holds the claude-rabbit/forensic-record@1 JSON for deep-path reports.
--    Null for fast-path / cache reports (no sandbox run happened).
-- ---------------------------------------------------------------------------
alter table public.reports
  add column if not exists forensics_json jsonb;

comment on column public.reports.forensics_json is
  'Structured forensic record from the dynamic sandbox sinkhole run (deep path): '
  'what ran, captured network intent (domains/intended IPs/geo), inert attempted-'
  'exfil payloads, in-VM behavior, the dynamic verdict, and the honest not_verified '
  'list. Null for fast-path and cache reports. Code/behavior signals only — '
  'reputation is kept separate per the safety rails.';

-- Partial index: only the deep reports that actually carry forensics. Keeps the
-- index small (most reports are fast-path with forensics_json null).
create index if not exists idx_reports_forensics
  on public.reports ((forensics_json is not null))
  where forensics_json is not null;

-- ---------------------------------------------------------------------------
-- 2. Service-role-only function to attach a forensic record to a report.
--    The sandbox orchestrator (server-side, holding the secret key) calls this
--    to persist the forensic JSON onto the matching report row, keyed by
--    owner+repo+commit SHA (the cache key). SECURITY DEFINER + revoked from
--    public so only the service role can write forensics.
-- ---------------------------------------------------------------------------
create or replace function public.attach_forensics(
  p_owner_login text,
  p_repo_name   text,
  p_commit_sha  text,
  p_forensics   jsonb
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_report_id bigint;
begin
  if p_owner_login is null or p_repo_name is null or p_commit_sha is null then
    raise exception 'owner_login, repo_name, and commit_sha are all required';
  end if;
  if p_forensics is null then
    raise exception 'forensics payload must not be null';
  end if;

  update public.reports
     set forensics_json = p_forensics,
         deep           = true,        -- a forensic record means the deep path ran
         updated_at     = now()
   where owner_login = p_owner_login
     and repo_name   = p_repo_name
     and commit_sha  = p_commit_sha
  returning id into v_report_id;

  if v_report_id is null then
    raise exception 'no report row for %/% @ %', p_owner_login, p_repo_name, p_commit_sha;
  end if;

  return v_report_id;
end;
$$;

-- Only the service role (edge function / orchestrator with the secret key) may
-- persist forensics. Clients never write this.
revoke execute on function public.attach_forensics(text, text, text, jsonb)
  from public, anon, authenticated;
grant  execute on function public.attach_forensics(text, text, text, jsonb)
  to service_role;
