-- =============================================================================
-- Claude Rabbit — Deep-scan dispatch queue (observability + honest FIFO record)
-- Migration: 20260702000002_deep_scan_queue.sql
--
-- WHY THIS EXISTS:
--   /api/deep detonates unknown repos on ONE warm sandbox host, capped at
--   MAX_CONCURRENT=2 simultaneous detonations (the host's 4-vCPU budget). Before
--   this change a 3rd concurrent request was FLATLY rejected with a 429 and simply
--   dropped — the caller had to hand-retry. That is the honesty gap this closes:
--   a 3rd request now QUEUES and waits its turn instead of vanishing.
--
--   This table is the OBSERVABILITY + FIFO-ORDERING record for that queue. It is
--   NOT the slot-locking mechanism: /api/deep runs in a single local controller
--   Node process, and the in-process `inFlight` counter there remains the sole,
--   race-free arbiter of "is a detonation slot actually free". This table records
--   each queued request so we can report an HONEST position ("position N of M")
--   and a real estimated wait, and so operators can see the queue depth. It never
--   grants a slot on its own.
--
-- MECHANISM:
--   One row per queued deep request. `created_at` gives the FIFO order (oldest
--   still-`queued` row is next in line). The controller inserts a `queued` row on
--   arrival, flips it to `active` when it acquires a slot, and to a terminal state
--   (`done` / `failed` / `timed_out`) when the run ends or the wait window elapses.
--   Position is computed as the count of OLDER still-`queued` rows (see
--   deep_queue_position). All mutation happens through SECURITY DEFINER functions
--   callable ONLY by the service role — clients never touch this table.
--
-- Scope: ADDITIVE only. New enum + table + functions. Alters no prior migration.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. deep_scan_queue_status — the lifecycle of a queued request.
--      queued     — waiting for a free detonation slot (FIFO by created_at)
--      active     — acquired a slot; the detonation is running
--      done       — the detonation finished (success or benign completion)
--      failed     — the detonation started but errored out
--      timed_out  — never acquired a slot within the max-wait deadline
--    `done`/`failed` distinguish a run that STARTED from `timed_out`, which never
--    ran — the honest "sandbox was too busy for too long" outcome.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'deep_scan_queue_status') then
    create type public.deep_scan_queue_status as enum (
      'queued', 'active', 'done', 'failed', 'timed_out'
    );
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 2. deep_scan_queue — one row per queued/running deep request.
-- ---------------------------------------------------------------------------
create table if not exists public.deep_scan_queue (
  -- The controller-generated per-request token (buildSlug on the route). Unique,
  -- VM-name-safe, distinct per request; used to look this row up on every update.
  token         text                            not null,
  owner_login   text                            not null,
  repo_name     text                            not null,
  commit_sha    text                            not null,
  status        public.deep_scan_queue_status   not null default 'queued',
  -- FIFO ordering key. A request enqueued earlier has a smaller created_at and is
  -- therefore ahead in line. Defaulted server-side so ordering is authoritative.
  created_at    timestamptz                     not null default now(),
  -- When the row left the `queued` state (acquired a slot or timed out). Null
  -- while still waiting. For honest post-hoc "how long did this wait" reporting.
  activated_at  timestamptz,
  -- When the row reached a terminal state (done/failed/timed_out).
  finished_at   timestamptz,
  updated_at    timestamptz                     not null default now(),

  constraint pk_deep_scan_queue primary key (token)
);

comment on table public.deep_scan_queue is
  'Observability + FIFO-ordering record for the /api/deep dispatch queue. NOT the '
  'slot lock: the controller''s in-process inFlight counter is the sole arbiter of a '
  'free detonation slot. One row per queued deep request; created_at gives FIFO '
  'order; status tracks its lifecycle. Service-role only.';

-- Hot path: "how many still-queued rows are OLDER than mine" (position) and "who
-- is the oldest still-queued row" (next in line). Both filter status='queued' and
-- order by created_at, so a partial index on the queued rows keyed by created_at
-- serves both cheaply while the table stays tiny.
create index if not exists idx_deep_scan_queue_waiting
  on public.deep_scan_queue (created_at)
  where status = 'queued';

-- ---------------------------------------------------------------------------
-- 3. deep_queue_enqueue — record a newly-queued request. Returns its row's
--    created_at (the authoritative FIFO key) so the caller can compute position.
-- ---------------------------------------------------------------------------
create or replace function public.deep_queue_enqueue(
  p_token       text,
  p_owner_login text,
  p_repo_name   text,
  p_commit_sha  text
)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_created_at timestamptz;
begin
  if p_token is null or trim(p_token) = '' then
    raise exception 'p_token must be supplied';
  end if;
  if p_owner_login is null or p_repo_name is null or p_commit_sha is null then
    raise exception 'owner_login, repo_name, and commit_sha are all required';
  end if;

  insert into public.deep_scan_queue (token, owner_login, repo_name, commit_sha, status)
  values (p_token, p_owner_login, p_repo_name, p_commit_sha, 'queued')
  on conflict (token) do update
    set status      = 'queued',
        owner_login = excluded.owner_login,
        repo_name   = excluded.repo_name,
        commit_sha  = excluded.commit_sha,
        updated_at  = now()
  returning created_at into v_created_at;

  -- Opportunistic prune of terminal rows older than a day so the table stays
  -- tiny without a separate cron. Cheap; runs on ~2% of enqueues.
  if random() < 0.02 then
    delete from public.deep_scan_queue
     where status in ('done', 'failed', 'timed_out')
       and finished_at < now() - interval '1 day';
  end if;

  return v_created_at;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. deep_queue_position — honest live position for a still-queued request:
--    the count of OLDER still-`queued` rows (0 == next in line), and the total
--    number of still-`queued` rows (for "position N of M"). A row that is no
--    longer queued (acquired / timed out) reports position 0 / total 0.
-- ---------------------------------------------------------------------------
create or replace function public.deep_queue_position(p_token text)
returns table (ahead integer, waiting_total integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_created_at timestamptz;
  v_status     public.deep_scan_queue_status;
begin
  select created_at, status into v_created_at, v_status
    from public.deep_scan_queue
   where token = p_token;

  -- Unknown or no-longer-queued row: nothing ahead, report the current depth.
  if v_created_at is null or v_status <> 'queued' then
    return query
      select 0,
             (select count(*)::integer from public.deep_scan_queue where status = 'queued');
    return;
  end if;

  return query
    select
      (select count(*)::integer
         from public.deep_scan_queue
        where status = 'queued'
          and created_at < v_created_at)                                as ahead,
      (select count(*)::integer
         from public.deep_scan_queue
        where status = 'queued')                                        as waiting_total;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. deep_queue_set_status — flip a row to a new lifecycle state, stamping the
--    matching timestamp. Idempotent and safe to call for an unknown token
--    (returns false) so the controller's cleanup paths never raise.
-- ---------------------------------------------------------------------------
create or replace function public.deep_queue_set_status(
  p_token  text,
  p_status public.deep_scan_queue_status
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
     set status       = p_status,
         updated_at   = now(),
         activated_at = case
                          when p_status = 'active' and activated_at is null then now()
                          else activated_at
                        end,
         finished_at  = case
                          when p_status in ('done', 'failed', 'timed_out') then now()
                          else finished_at
                        end
   where token = p_token
  returning true into v_found;

  return coalesce(v_found, false);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Lock down: only the service role (the controller, via a runner-key-gated
--    edge function holding the service key) may enqueue, read position, or flip
--    status. Clients never touch the queue.
-- ---------------------------------------------------------------------------
revoke execute on function public.deep_queue_enqueue(text, text, text, text)
  from public, anon, authenticated;
grant  execute on function public.deep_queue_enqueue(text, text, text, text)
  to service_role;

revoke execute on function public.deep_queue_position(text)
  from public, anon, authenticated;
grant  execute on function public.deep_queue_position(text)
  to service_role;

revoke execute on function public.deep_queue_set_status(text, public.deep_scan_queue_status)
  from public, anon, authenticated;
grant  execute on function public.deep_queue_set_status(text, public.deep_scan_queue_status)
  to service_role;

-- ---------------------------------------------------------------------------
-- 7. RLS — no client access at all; service-role only (mirrors scan_rate_limit
--    and the forensics write path).
-- ---------------------------------------------------------------------------
alter table public.deep_scan_queue enable row level security;

create policy "deep_scan_queue_service_only"
  on public.deep_scan_queue
  for all
  to service_role
  using (true)
  with check (true);

grant all on public.deep_scan_queue to service_role;
