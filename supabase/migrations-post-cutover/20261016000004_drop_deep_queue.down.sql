-- Reverse of 20261016000004_drop_deep_queue.sql: the original DDL of 20260702000002, 20260703000001 and 20260711000001, in order, comments removed.

-- from 20260702000002_deep_scan_queue.sql

do $$
begin
  if not exists (select 1 from pg_type where typname = 'deep_scan_queue_status') then
    create type public.deep_scan_queue_status as enum (
      'queued', 'active', 'done', 'failed', 'timed_out'
    );
  end if;
end
$$;

create table if not exists public.deep_scan_queue (
  token         text                            not null,
  owner_login   text                            not null,
  repo_name     text                            not null,
  commit_sha    text                            not null,
  status        public.deep_scan_queue_status   not null default 'queued',
  created_at    timestamptz                     not null default now(),
  activated_at  timestamptz,
  finished_at   timestamptz,
  updated_at    timestamptz                     not null default now(),

  constraint pk_deep_scan_queue primary key (token)
);

comment on table public.deep_scan_queue is
  'Observability + FIFO-ordering record for the /api/deep dispatch queue. NOT the '
  'slot lock: the controller''s in-process inFlight counter is the sole arbiter of a '
  'free detonation slot. One row per queued deep request; created_at gives FIFO '
  'order; status tracks its lifecycle. Service-role only.';

create index if not exists idx_deep_scan_queue_waiting
  on public.deep_scan_queue (created_at)
  where status = 'queued';

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

  if random() < 0.02 then
    delete from public.deep_scan_queue
     where status in ('done', 'failed', 'timed_out')
       and finished_at < now() - interval '1 day';
  end if;

  return v_created_at;
end;
$$;

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

alter table public.deep_scan_queue enable row level security;

create policy "deep_scan_queue_service_only"
  on public.deep_scan_queue
  for all
  to service_role
  using (true)
  with check (true);

grant all on public.deep_scan_queue to service_role;

-- from 20260703000001_deep_scan_queue_stage.sql

alter table public.deep_scan_queue
  add column if not exists current_stage        text,
  add column if not exists current_stage_detail text;

comment on column public.deep_scan_queue.current_stage is
  'Real, granular progress marker reported live by the Cloud Run execution''s own entrypoint (container_start, cloning, installing, running, agent_install/agent_runtime/agent_payload, assembling_forensics, persisting); NOT a lifecycle status (see deep_scan_queue_status for that). Null until the execution reports its first stage.';

comment on column public.deep_scan_queue.current_stage_detail is
  'A short, real, human-readable detail for the current_stage (e.g. the actual package manager detected, or which agent just started); never a canned/generic string.';

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

revoke execute on function public.deep_queue_set_stage(text, text, text)
  from public, anon, authenticated;
grant  execute on function public.deep_queue_set_stage(text, text, text)
  to service_role;

revoke execute on function public.deep_queue_get_stage(text)
  from public, anon, authenticated;
grant  execute on function public.deep_queue_get_stage(text)
  to service_role;

-- from 20260711000001_deep_dispatch_lock.sql

create table if not exists public.deep_dispatch_lock (
  owner_login text        not null,
  repo_name   text        not null,
  commit_sha  text        not null,
  token       text,
  claimed_at  timestamptz not null default now(),

  constraint pk_deep_dispatch_lock primary key (owner_login, repo_name, commit_sha)
);

comment on table public.deep_dispatch_lock is
  'Atomic per-(owner,repo,sha) lock that dedups /api/deep detonation dispatch across '
  'Vercel instances: a commit already being detonated cannot be dispatched a second '
  'time. TTL-stealable so a crashed claimer never wedges a commit. Service-role only.';

create index if not exists idx_deep_dispatch_lock_claimed_at
  on public.deep_dispatch_lock (claimed_at);

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

  insert into public.deep_dispatch_lock as l (owner_login, repo_name, commit_sha, token, claimed_at)
  values (p_owner, p_repo, p_sha, p_token, now())
  on conflict (owner_login, repo_name, commit_sha) do update
    set claimed_at = now(),
        token      = excluded.token
    where l.claimed_at < now() - make_interval(secs => greatest(p_ttl_seconds, 1))
  returning true into v_claimed;

  if random() < 0.02 then
    delete from public.deep_dispatch_lock
     where claimed_at < now() - interval '1 hour';
  end if;

  return coalesce(v_claimed, false);
end;
$$;

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

revoke execute on function public.deep_dispatch_try_claim(text, text, text, text, integer)
  from public, anon, authenticated;
grant  execute on function public.deep_dispatch_try_claim(text, text, text, text, integer)
  to service_role;

revoke execute on function public.deep_dispatch_release(text, text, text, text)
  from public, anon, authenticated;
grant  execute on function public.deep_dispatch_release(text, text, text, text)
  to service_role;

alter table public.deep_dispatch_lock enable row level security;

create policy "deep_dispatch_lock_service_only"
  on public.deep_dispatch_lock
  for all
  to service_role
  using (true)
  with check (true);

grant all on public.deep_dispatch_lock to service_role;
