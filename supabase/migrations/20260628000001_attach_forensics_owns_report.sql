-- ---------------------------------------------------------------------------
-- U1 — Escalation owns a fresh complete report.
--
-- The deep run no longer just bolts a forensic record onto the stage-1 report.
-- When forensics attach, the ESCALATION owns the report: a fresh runtime-primary
-- score, a band-matched verdict, a runtime-first hedge-free summary, and rewritten
-- log chapters are all persisted ATOMICALLY with the forensics, so a fresh deep run
-- and a later cached view of the same commit SHA are byte-identical (BUG-17).
--
-- This REPLACES the 4-arg attach_forensics with an 8-arg version. `create or
-- replace` cannot change a function's argument signature (it would create an
-- overload, leaving the old 4-arg version live), so we DROP the old one first and
-- re-issue the grants for the new signature (grants are per-signature).
-- ---------------------------------------------------------------------------

drop function if exists public.attach_forensics(text, text, text, jsonb);

create function public.attach_forensics(
  p_owner_login text,
  p_repo_name   text,
  p_commit_sha  text,
  p_forensics   jsonb,
  p_score       integer,
  p_verdict     text,
  p_summary     text,
  p_logs        jsonb
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

  -- The escalation OWNS the report: write the fresh score/verdict/summary/logs
  -- alongside the forensics in one atomic UPDATE. COALESCE keeps the existing value
  -- when a param is null, so a forensics-only caller still works defensively.
  update public.reports
     set forensics_json = p_forensics,
         deep           = true,        -- a forensic record means the deep path ran
         score          = coalesce(p_score, score),
         verdict        = coalesce(p_verdict, verdict),
         summary        = coalesce(p_summary, summary),
         logs_json      = coalesce(p_logs, logs_json),
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

-- Only the service role (edge function with the secret key) may persist forensics.
-- Grants are per-signature, so re-issue them for the new 8-arg function.
revoke execute on function
  public.attach_forensics(text, text, text, jsonb, integer, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function
  public.attach_forensics(text, text, text, jsonb, integer, text, text, jsonb)
  to service_role;
