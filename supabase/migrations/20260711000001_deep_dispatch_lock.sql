-- =============================================================================
-- Claude Rabbit — Atomic per-commit detonation dispatch lock
-- Migration: 20260711000001_deep_dispatch_lock.sql
--
-- WHY THIS EXISTS (the bug it closes):
--   /api/deep's PUBLIC production path (handleRestDeep) triggers a real Cloud Run
--   Job execution for any (owner, repo, sha) the fast path has already escalated.
--   Its only abuse bound was the report-row precondition ("has this commit been
--   escalated?") — but that precondition stays TRUE for the entire ~2.5–3.5 min
--   window between escalation and the container's forensics landing. So EVERY
--   repeated /api/deep call for the same escalated commit during that window
--   passed the precondition and span up ANOTHER Cloud Run execution:
--     * a cost-amplification vector (one escalated commit → N billed detonations),
--     * and a flood of the single shared NVA egress gateway (proven to carry only
--       ~3 concurrent detonations — see docs/INFRASTRUCTURE.md §8b).
--   The in-process inFlight/MAX_CONCURRENT throttle does NOT help here: the REST
--   path returns before it, AND Vercel runs MANY function instances, so an
--   in-memory counter cannot bound anything across them. The ONLY thing that can
--   dedup dispatch across instances is shared, atomic DB state — this table.
--
-- MECHANISM:
--   One row per (owner, repo, sha) that is CURRENTLY being detonated. A dispatch
--   claims the row atomically (INSERT … ON CONFLICT) BEFORE triggering Cloud Run;
--   a concurrent/repeat request for the same commit fails to claim and instead
--   just polls the report row for the in-flight run's forensics (no second
--   execution). The claim carries a TTL: a stale claim (older than the TTL, e.g.
--   from a crashed controller) is stealable, so a commit can never be wedged
--   un-detonatable forever. All access is through SECURITY DEFINER functions
--   callable ONLY by the service role (via the runner-key-gated deep-queue edge
--   function) — clients never touch this table.
--
-- Scope: ADDITIVE only. New table + two functions. Alters no prior migration.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. deep_dispatch_lock — one row per commit whose detonation is in flight.
--    PRIMARY KEY (owner, repo, sha) is what makes the claim atomic: two
--    simultaneous dispatches for the same commit collide on it, and ON CONFLICT
--    lets exactly one win.
-- ---------------------------------------------------------------------------
create table if not exists public.deep_dispatch_lock (
  owner_login text        not null,
  repo_name   text        not null,
  commit_sha  text        not null,
  -- The claiming dispatch's per-request token (the route's buildSlug). Recorded so
  -- release() can verify the releaser still owns the claim (a dispatch whose claim
  -- was TTL-stolen by a newer one must NOT delete the newer holder's row).
  token       text,
  -- When the current holder claimed it. A claim older than the TTL is stealable.
  claimed_at  timestamptz not null default now(),

  constraint pk_deep_dispatch_lock primary key (owner_login, repo_name, commit_sha)
);

comment on table public.deep_dispatch_lock is
  'Atomic per-(owner,repo,sha) lock that dedups /api/deep detonation dispatch across '
  'Vercel instances: a commit already being detonated cannot be dispatched a second '
  'time. TTL-stealable so a crashed claimer never wedges a commit. Service-role only.';

-- Housekeeping index for the opportunistic prune of long-dead locks.
create index if not exists idx_deep_dispatch_lock_claimed_at
  on public.deep_dispatch_lock (claimed_at);

-- ---------------------------------------------------------------------------
-- 2. deep_dispatch_try_claim — atomically claim the detonation of one commit.
--    Returns TRUE  → the caller won the claim and SHOULD dispatch Cloud Run.
--            FALSE → a fresh claim is already held by another dispatch; the
--                    caller must NOT dispatch (it should attach to the in-flight
--                    run by polling the report row instead).
--    A claim older than p_ttl_seconds is treated as dead and is stolen (TRUE),
--    so a crashed controller can never make a commit permanently un-detonatable.
-- ---------------------------------------------------------------------------
create or replace function public.deep_dispatch_try_claim(
  p_owner       text,
  p_repo        text,
  p_sha         text,
  p_token       text,
  p_ttl_seconds integer default 420
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_claimed boolean;
begin
  if p_owner is null or p_repo is null or p_sha is null then
    raise exception 'owner, repo, and sha are all required';
  end if;

  -- Atomic: insert if free, OR steal a claim older than the TTL. When a FRESH
  -- claim is held, the ON CONFLICT ... WHERE is false → no row is written →
  -- RETURNING yields nothing → v_claimed is NULL → coalesced to false below.
  insert into public.deep_dispatch_lock as l (owner_login, repo_name, commit_sha, token, claimed_at)
  values (p_owner, p_repo, p_sha, p_token, now())
  on conflict (owner_login, repo_name, commit_sha) do update
    set claimed_at = now(),
        token      = excluded.token
    where l.claimed_at < now() - make_interval(secs => greatest(p_ttl_seconds, 1))
  returning true into v_claimed;

  -- Opportunistic prune of long-dead locks (well past any TTL) so the table stays
  -- tiny without a separate cron. Cheap; runs on ~2% of claims.
  if random() < 0.02 then
    delete from public.deep_dispatch_lock
     where claimed_at < now() - interval '1 hour';
  end if;

  return coalesce(v_claimed, false);
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. deep_dispatch_release — release a claim when the run truly concludes
--    (forensics attached, or a hard dispatch failure that should allow a retry).
--    Only the CURRENT holder (matching token) may release, so a dispatch whose
--    claim was already TTL-stolen by a newer one cannot delete the newer holder's
--    claim. Safe to call for an unknown/foreign lock (returns false).
--    Deliberately NOT called on the streaming-deadline "pending" path: there the
--    detonation is still running, so the lock must persist (TTL-bounded) to keep
--    deduping re-requests during the run's tail.
-- ---------------------------------------------------------------------------
create or replace function public.deep_dispatch_release(
  p_owner text,
  p_repo  text,
  p_sha   text,
  p_token text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_released boolean;
begin
  delete from public.deep_dispatch_lock
   where owner_login = p_owner
     and repo_name   = p_repo
     and commit_sha  = p_sha
     and (p_token is null or token = p_token)
  returning true into v_released;

  return coalesce(v_released, false);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Lock down: service role only (the controller, via the runner-key-gated
--    deep-queue edge function). Clients never touch dispatch locking.
-- ---------------------------------------------------------------------------
revoke execute on function public.deep_dispatch_try_claim(text, text, text, text, integer)
  from public, anon, authenticated;
grant  execute on function public.deep_dispatch_try_claim(text, text, text, text, integer)
  to service_role;

revoke execute on function public.deep_dispatch_release(text, text, text, text)
  from public, anon, authenticated;
grant  execute on function public.deep_dispatch_release(text, text, text, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- 5. RLS — no client access at all; service-role only (mirrors deep_scan_queue).
-- ---------------------------------------------------------------------------
alter table public.deep_dispatch_lock enable row level security;

create policy "deep_dispatch_lock_service_only"
  on public.deep_dispatch_lock
  for all
  to service_role
  using (true)
  with check (true);

grant all on public.deep_dispatch_lock to service_role;
