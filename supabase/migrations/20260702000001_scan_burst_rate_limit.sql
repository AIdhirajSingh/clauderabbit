-- =============================================================================
-- Claude Rabbit — Burst/velocity rate limiting for the public scan endpoint
-- Migration: 20260702000001_scan_burst_rate_limit.sql
--
-- WHY THIS EXISTS (the security review of BUG-9):
--   The scan edge function was deliberately made UNLIMITED (BUG-9): no daily cap,
--   because free unmetered scans are core to this product's growth and the GCP
--   credit covers the model cost. That decision is PRESERVED here — this migration
--   does NOT reintroduce a daily quota and does NOT resurrect the old
--   check_and_increment_scan_limit()/scan_usage daily-cap machinery.
--
--   What was missing is DoS/abuse protection. Every POST to /functions/v1/scan
--   triggers a real billed Vertex/Gemini call plus a live GitHub API call (shared
--   5000/hr token). With zero throttling, a scripted loop sending random
--   owner/repo/deviceId each request can burn the model budget and exhaust the
--   GitHub token in seconds. This adds BURST/VELOCITY limiting: it stops a flood of
--   requests-per-minute from one source, while a human scanning a handful of repos
--   — or an AI agent's CLI/MCP tool making occasional real scans across a day —
--   never trips it.
--
-- MECHANISM:
--   A fixed 60-second tumbling window counter keyed by a coarse "bucket key"
--   (the caller's IP, and separately the caller's hashed device id). Because edge
--   functions are stateless and multi-instance, the counter lives in Postgres —
--   the only shared state across invocations. Each request atomically upserts and
--   increments its window row and reads back the new count in ONE statement, so
--   concurrent requests from the same source cannot race past the limit.
--
-- Scope: ADDITIVE only. New table + new function. Does not alter prior migrations.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. scan_rate_limit — per-(bucket, window) request counters.
--    Distinct from scan_usage (daily quota, intentionally unused per BUG-9):
--    this is a short-lived velocity counter, pruned continuously.
-- ---------------------------------------------------------------------------
create table public.scan_rate_limit (
  -- A coarse identity for the caller. Prefixed by kind so an IP bucket and a
  -- device bucket can never collide even if their raw values coincide:
  --   'ip:<client-ip>'        — velocity per source IP
  --   'dev:<sha256 deviceId>' — velocity per client device fingerprint
  bucket_key    text          not null,
  -- Start of the fixed tumbling window (UTC, truncated to the window size). A
  -- request at 12:00:37 and one at 12:00:59 share the same window_start; the
  -- next window begins at 12:01:00.
  window_start  timestamptz   not null,
  -- Requests seen from this bucket in this window.
  request_count integer       not null default 0 check (request_count >= 0),
  created_at    timestamptz   not null default now(),

  constraint pk_scan_rate_limit primary key (bucket_key, window_start)
);

-- Prune index: old windows are deleted opportunistically by the function below.
create index idx_scan_rate_limit_window
  on public.scan_rate_limit (window_start);

-- ---------------------------------------------------------------------------
-- 2. check_scan_rate_limit(p_bucket_key, p_limit, p_window_seconds)
--
--    Atomically records one request against the caller's CURRENT window and
--    reports whether the caller is now over the limit. Returns:
--      allowed        — false once the window count EXCEEDS p_limit
--      current_count  — the count in this window after recording this request
--      retry_after    — seconds until the current window rolls over (for the
--                        429 Retry-After header)
--
--    The upsert + increment + read-back is a single INSERT ... ON CONFLICT DO
--    UPDATE ... RETURNING, so it is atomic under concurrency: two simultaneous
--    requests for the same bucket both land on the same row and are serialized
--    by the row lock the upsert takes, each seeing a distinct incremented count.
--    No SELECT-then-UPDATE gap for a flood to slip through.
--
--    SECURITY DEFINER + revoked from public/anon/authenticated: only the service
--    role (the edge function) may call it. Clients never touch this table.
-- ---------------------------------------------------------------------------
create or replace function public.check_scan_rate_limit(
  p_bucket_key     text,
  p_limit          integer,
  p_window_seconds integer
)
returns table (allowed boolean, current_count integer, retry_after integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_window_start timestamptz;
  v_count        integer;
  v_next_window  timestamptz;
begin
  if p_bucket_key is null or trim(p_bucket_key) = '' then
    raise exception 'p_bucket_key must be supplied';
  end if;
  if p_limit is null or p_limit < 1 then
    raise exception 'p_limit must be >= 1';
  end if;
  if p_window_seconds is null or p_window_seconds < 1 then
    raise exception 'p_window_seconds must be >= 1';
  end if;

  -- Truncate now() to the start of the current fixed window. to_timestamp of the
  -- floored epoch gives a stable window boundary shared by all requests in it.
  v_window_start := to_timestamp(
    floor(extract(epoch from clock_timestamp()) / p_window_seconds) * p_window_seconds
  );
  v_next_window := v_window_start + make_interval(secs => p_window_seconds);

  -- Atomic upsert-and-increment: one statement, row-locked on conflict.
  insert into public.scan_rate_limit (bucket_key, window_start, request_count)
  values (p_bucket_key, v_window_start, 1)
  on conflict (bucket_key, window_start)
  do update set request_count = public.scan_rate_limit.request_count + 1
  returning request_count into v_count;

  -- Opportunistic prune of windows at least two windows old, so the table stays
  -- tiny without a separate cron. Cheap: bounded by the window index. Runs only
  -- ~1% of calls to avoid adding a delete to every request.
  if random() < 0.01 then
    delete from public.scan_rate_limit
    where window_start < clock_timestamp() - make_interval(secs => p_window_seconds * 2);
  end if;

  return query select
    (v_count <= p_limit)                                     as allowed,
    v_count                                                  as current_count,
    greatest(1, ceil(extract(epoch from (v_next_window - clock_timestamp()))))::integer
                                                             as retry_after;
end;
$$;

-- Only the service role (edge function) may call this. Clients never do.
revoke execute on function public.check_scan_rate_limit(text, integer, integer)
  from public, anon, authenticated;
grant  execute on function public.check_scan_rate_limit(text, integer, integer)
  to service_role;

-- ---------------------------------------------------------------------------
-- 3. RLS — no client access at all; service-role only (mirrors scan_usage).
-- ---------------------------------------------------------------------------
alter table public.scan_rate_limit enable row level security;

create policy "scan_rate_limit_service_only"
  on public.scan_rate_limit
  for all
  to service_role
  using (true)
  with check (true);

grant all on public.scan_rate_limit to service_role;
