-- =============================================================================
-- Claude Rabbit — real, granular detonation progress (deep_scan_queue.current_stage)
-- Migration: 20260703000001_deep_scan_queue_stage.sql
--
-- WHY THIS EXISTS:
--   Once a detonation is dispatched, /api/deep's processing timeline showed ONE
--   static, unmoving line ("Gate tripped — dispatching a Cloud Run detonation
--   execution") for the entire ~100-160s real detonation window — real work was
--   happening (container starting, repo cloning, dependencies installing, the
--   run itself, each analysis agent, forensics assembly, persisting), but the
--   user had no way to tell a slow-but-healthy repo from a genuinely stalled one,
--   unlike the earlier Resolve/Static-scan/Reputation/Read/Verdict/Escalation
--   steps, which already show real step-by-step progress.
--
--   This adds two columns the Cloud Run execution's own entrypoint (which
--   already has network egress, routed through the same forge) reports real
--   progress markers to via the SAME runner-key-gated `deep-queue` edge function
--   it already uses for observability — a new "stage" op alongside the existing
--   enqueue/position/status ops. /api/deep polls this DURING the detonation
--   wait (not just after) and emits each real stage transition to the client.
--
-- Scope: ADDITIVE only. Alters no prior migration's columns/functions/data.
-- =============================================================================

alter table public.deep_scan_queue
  add column if not exists current_stage        text,
  add column if not exists current_stage_detail text;

comment on column public.deep_scan_queue.current_stage is
  'Real, granular progress marker reported live by the Cloud Run execution''s own entrypoint (container_start, cloning, installing, running, agent_install/agent_runtime/agent_payload, assembling_forensics, persisting) — NOT a lifecycle status (see deep_scan_queue_status for that). Null until the execution reports its first stage.';

comment on column public.deep_scan_queue.current_stage_detail is
  'A short, real, human-readable detail for the current_stage (e.g. the actual package manager detected, or which agent just started) — never a canned/generic string.';

-- ---------------------------------------------------------------------------
-- deep_queue_set_stage — the execution reports a real progress marker. Bumps
-- updated_at so a poller can distinguish "no new stage yet" from "still alive".
-- ---------------------------------------------------------------------------
create or replace function public.deep_queue_set_stage(
  p_token  text,
  p_stage  text,
  p_detail text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_found boolean := false;
begin
  update public.deep_scan_queue
     set current_stage        = p_stage,
         current_stage_detail = p_detail,
         updated_at           = now()
   where token = p_token
  returning true into v_found;

  return coalesce(v_found, false);
end;
$$;

-- ---------------------------------------------------------------------------
-- deep_queue_get_stage — /api/deep's polling read during the detonation wait.
-- ---------------------------------------------------------------------------
create or replace function public.deep_queue_get_stage(p_token text)
returns table(current_stage text, current_stage_detail text, updated_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
    select q.current_stage, q.current_stage_detail, q.updated_at
      from public.deep_scan_queue q
     where q.token = p_token;
end;
$$;

-- ---------------------------------------------------------------------------
-- Lock down: service role only, same as every other queue RPC.
-- ---------------------------------------------------------------------------
revoke execute on function public.deep_queue_set_stage(text, text, text)
  from public, anon, authenticated;
grant  execute on function public.deep_queue_set_stage(text, text, text)
  to service_role;

revoke execute on function public.deep_queue_get_stage(text)
  from public, anon, authenticated;
grant  execute on function public.deep_queue_get_stage(text)
  to service_role;
