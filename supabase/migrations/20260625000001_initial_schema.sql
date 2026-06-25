-- =============================================================================
-- Claude Rabbit — Initial Schema
-- Migration: 20260625000001_initial_schema.sql
--
-- Tables: owners, reports, profiles, scans, scan_usage
-- All tables have RLS enabled.
-- Service-role (secret key) is the only writer for owners, reports, scans,
-- scan_usage. Profiles are writer-accessible only to the owning user (via edge
-- function / service role) and readable only by the owning user.
-- Public (publishable-key / anon) reads: owners, reports (the SEO surface).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------------
create extension if not exists "pgcrypto";   -- gen_random_uuid() fallback
create extension if not exists "pg_stat_statements";  -- query monitoring

-- ---------------------------------------------------------------------------
-- Shared helper: updated_at auto-stamp trigger
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- =============================================================================
-- 1. owners
--    Reputation cache keyed by github_login. Written only by edge functions
--    (service role). Read publicly (reputation signals shown on every report).
-- =============================================================================
create table public.owners (
  id                bigint        generated always as identity primary key,
  github_login      text          not null unique,
  display_name      text,
  -- Account-age as a human-readable string (e.g. "8 yr 2 mo", "3 days")
  account_age_label text,
  -- Machine-readable GitHub account creation date for TTL logic
  created_at_github timestamptz,
  established       boolean       not null default false,
  public_repos      integer,
  stars_total       integer,
  -- e.g. "Widely trusted, referenced across tutorials and production stacks."
  sentiment         text,
  -- Sentiment score 0–100
  sentiment_score   integer       check (sentiment_score between 0 and 100),
  -- Full reputation JSON blob (raw Brave/search result) for future enrichment
  reputation_json   jsonb,
  -- When this owner record was last refreshed (for TTL-based re-fetch)
  fetched_at        timestamptz   not null default now(),
  created_at        timestamptz   not null default now(),
  updated_at        timestamptz   not null default now()
);

-- NOTE: github_login already has a UNIQUE constraint, which creates an implicit
-- index. A separate idx_owners_github_login would be redundant — omitted.
create index idx_owners_fetched_at   on public.owners (fetched_at);

create trigger trg_owners_updated_at
  before update on public.owners
  for each row execute function public.set_updated_at();

-- =============================================================================
-- 2. reports
--    One row per (owner_login, repo_name, commit_sha) — the cache-by-SHA asset.
--    Written only by edge functions (service role). Read publicly (SEO surface).
-- =============================================================================
create table public.reports (
  id              bigint        generated always as identity primary key,
  -- Denormalized for fast lookup without JOIN on every public page
  owner_login     text          not null,
  repo_name       text          not null,
  commit_sha      text          not null,
  -- Human-readable ref that was resolved (branch, tag, "main", etc.)
  ref             text,

  -- FK to the owners reputation cache (nullable: owner may not be cached yet)
  owner_id        bigint        references public.owners (id) on delete set null,

  -- Core verdict
  score           integer       not null check (score between 0 and 100),
  -- e.g. "Trusted", "Likely safe", "Caution", "High risk", "Malicious"
  verdict         text          not null,
  -- Whether this report was served from cache on the request that created it
  cached          boolean       not null default false,
  -- Whether the deep (dynamic sandbox) path was taken
  deep            boolean       not null default false,
  -- Plain-language summary paragraph
  summary         text,

  -- 0.0–1.0 confidence emitted by the read/blend step
  confidence      numeric(4,3)  check (confidence between 0 and 1),
  -- 'cache' | 'fast' | 'deep'
  scan_path       text          not null check (scan_path in ('cache', 'fast', 'deep')),

  -- JSON blobs — structured findings stored as-is from the edge function
  -- stats_json:     { loc, packages (count), stars, created }
  stats_json      jsonb,
  -- packages_json:  [ { name, score, note } ]
  packages_json   jsonb,
  -- risky_json:     [ { title, severity, kind, detail } ]
  risky_json      jsonb,
  -- logs_json:      [ { ch, kind, lines[] } ]
  logs_json       jsonb,

  created_at      timestamptz   not null default now(),
  updated_at      timestamptz   not null default now(),

  -- The cache key: a report is uniquely identified by owner+repo+SHA
  constraint uq_reports_owner_repo_sha unique (owner_login, repo_name, commit_sha)
);

-- Fast lookup for the public /owner/repo page (latest report for a repo)
create index idx_reports_owner_repo
  on public.reports (owner_login, repo_name, created_at desc);

-- The canonical cache-check path: O(1) hit on exact SHA
create index idx_reports_sha
  on public.reports (owner_login, repo_name, commit_sha);

-- Leaderboard: lowest scores first, filtering to deep-run confirmed catches
create index idx_reports_leaderboard
  on public.reports (score asc, deep desc, created_at desc);

-- Activity feed: recent scans across all repos (homepage ticker)
create index idx_reports_recent
  on public.reports (created_at desc);

-- RLS policy column — index so per-row evaluation stays O(log n)
create index idx_reports_owner_login
  on public.reports (owner_login);

create trigger trg_reports_updated_at
  before update on public.reports
  for each row execute function public.set_updated_at();

-- =============================================================================
-- 3. profiles
--    1:1 with auth.users. Created automatically via trigger on user insert.
--    Users can read and update only their own row.
-- =============================================================================
create table public.profiles (
  -- PK mirrors the auth.users id — no synthetic key needed
  id            uuid          primary key references auth.users (id) on delete cascade,
  display_name  text,
  email         text,
  -- Seed string for the avatar generator (not a real image path)
  avatar_seed   text,
  created_at    timestamptz   not null default now(),
  updated_at    timestamptz   not null default now()
);

-- NOTE: id is the PRIMARY KEY, which already creates an implicit index.
-- A separate idx_profiles_id would be redundant — omitted.

create trigger trg_profiles_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- Auto-create a profile row whenever a new auth user is inserted
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name, email, avatar_seed)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)),
    new.email,
    new.id::text   -- use the UUID as the avatar seed
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger trg_auth_user_insert
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- =============================================================================
-- 4. scans
--    One row per scan event. Drives: dashboard history, activity feed, limits.
--    user_id is nullable for the free first scan (no login required).
--    Written only by edge functions (service role).
-- =============================================================================
create table public.scans (
  id            bigint        generated always as identity primary key,
  -- Nullable: the free first scan has no user session
  user_id       uuid          references auth.users (id) on delete set null,
  -- Device fingerprint for rate-limiting pre-auth scans (hashed on write)
  device_id     text,
  -- FK to the persisted report (may be null while status = 'processing')
  report_id     bigint        references public.reports (id) on delete set null,
  -- Denormalized for fast list rendering without a JOIN
  owner_login   text          not null,
  repo_name     text          not null,
  -- 'cache' | 'fast' | 'deep'
  scan_path     text          check (scan_path in ('cache', 'fast', 'deep')),
  score         integer       check (score between 0 and 100),
  -- 'processing' | 'done' | 'failed'
  status        text          not null default 'processing'
                              check (status in ('processing', 'done', 'failed')),
  is_dynamic    boolean       not null default false,
  created_at    timestamptz   not null default now(),
  updated_at    timestamptz   not null default now()
);

-- Dashboard history: a user's own scans, newest first
create index idx_scans_user_created
  on public.scans (user_id, created_at desc)
  where user_id is not null;

-- Activity feed view source: most recent scans across all users (anon-safe)
create index idx_scans_created
  on public.scans (created_at desc);

-- Daily limit enforcement: count by (user_id, day) and by (device_id, day)
create index idx_scans_user_day
  on public.scans (user_id, date_trunc('day', created_at at time zone 'UTC'))
  where user_id is not null;

create index idx_scans_device_day
  on public.scans (device_id, date_trunc('day', created_at at time zone 'UTC'))
  where device_id is not null;

create trigger trg_scans_updated_at
  before update on public.scans
  for each row execute function public.set_updated_at();

-- =============================================================================
-- 5. scan_usage
--    Daily counters per (user_id OR device_id, day). Service-role only.
--    Checked and incremented atomically by check_and_increment_scan_limit().
-- =============================================================================
create table public.scan_usage (
  id              bigint    generated always as identity primary key,
  -- Exactly one of user_id / device_id is non-null per row
  user_id         uuid      references auth.users (id) on delete cascade,
  device_id       text,
  -- UTC calendar day (no time component)
  usage_day       date      not null,
  stage1_count    integer   not null default 0 check (stage1_count >= 0),
  dynamic_count   integer   not null default 0 check (dynamic_count >= 0),

  constraint uq_scan_usage_user_day
    unique (user_id, usage_day),
  constraint uq_scan_usage_device_day
    unique (device_id, usage_day),
  -- Enforce exactly-one-of: cannot have both null or both non-null
  constraint chk_scan_usage_identity
    check (
      (user_id is not null and device_id is null)
      or
      (user_id is null and device_id is not null)
    )
);

create index idx_scan_usage_user_day
  on public.scan_usage (user_id, usage_day)
  where user_id is not null;

create index idx_scan_usage_device_day
  on public.scan_usage (device_id, usage_day)
  where device_id is not null;

-- =============================================================================
-- 6. Limit-enforcement function
--    check_and_increment_scan_limit(p_user_id, p_device_id, p_scan_type)
--
--    p_scan_type: 'stage1' or 'dynamic'
--    Limits: 3 stage-1 / day, 1 dynamic / day (per user_id or device_id).
--    Returns: (allowed bool, remaining int)
--    SECURITY DEFINER so edge functions can call it without client access to
--    scan_usage. Runs as the function owner (postgres), not the caller.
-- =============================================================================
create or replace function public.check_and_increment_scan_limit(
  p_user_id   uuid,
  p_device_id text,
  p_scan_type text   -- 'stage1' | 'dynamic'
)
returns table (allowed boolean, remaining integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_stage1_limit  constant integer := 3;
  v_dynamic_limit constant integer := 1;
  v_limit         integer;
  v_today         date := current_date;
  v_current       integer;
  v_row           public.scan_usage%rowtype;
begin
  -- Validate inputs
  if p_scan_type not in ('stage1', 'dynamic') then
    raise exception 'invalid p_scan_type: %', p_scan_type;
  end if;
  if p_user_id is null and (p_device_id is null or trim(p_device_id) = '') then
    raise exception 'at least one of p_user_id or p_device_id must be supplied';
  end if;

  v_limit := case p_scan_type
    when 'stage1'   then v_stage1_limit
    when 'dynamic'  then v_dynamic_limit
  end;

  -- Upsert the usage row for today, then read current value
  if p_user_id is not null then
    insert into public.scan_usage (user_id, usage_day, stage1_count, dynamic_count)
    values (p_user_id, v_today, 0, 0)
    on conflict (user_id, usage_day) do nothing;

    select * into v_row
    from public.scan_usage
    where user_id = p_user_id
      and usage_day = v_today
    for update;
  else
    insert into public.scan_usage (device_id, usage_day, stage1_count, dynamic_count)
    values (p_device_id, v_today, 0, 0)
    on conflict (device_id, usage_day) do nothing;

    select * into v_row
    from public.scan_usage
    where device_id = p_device_id
      and usage_day = v_today
    for update;
  end if;

  -- Race guard: the upsert above should guarantee the row exists, but a
  -- concurrent DELETE between the INSERT ... ON CONFLICT DO NOTHING and the
  -- SELECT ... FOR UPDATE could remove it. If the row is gone, fail loudly
  -- rather than treating a missing row as zero usage (which would silently
  -- bypass the daily limit).
  if not found then
    raise exception 'scan_usage row missing for user_id=%, device_id=%, day=%',
      p_user_id, p_device_id, v_today;
  end if;

  v_current := case p_scan_type
    when 'stage1'  then v_row.stage1_count
    when 'dynamic' then v_row.dynamic_count
  end;

  if v_current >= v_limit then
    return query select false, 0;
    return;
  end if;

  -- Increment atomically (row is already locked by FOR UPDATE above)
  if p_scan_type = 'stage1' then
    update public.scan_usage
    set stage1_count = stage1_count + 1
    where id = v_row.id;
    v_current := v_current + 1;
  else
    update public.scan_usage
    set dynamic_count = dynamic_count + 1
    where id = v_row.id;
    v_current := v_current + 1;
  end if;

  return query select true, (v_limit - v_current);
end;
$$;

-- Revoke public execute; only service role (edge functions) may call this
revoke execute on function public.check_and_increment_scan_limit(uuid, text, text)
  from public, anon, authenticated;

-- =============================================================================
-- 7. Public views
--
--    Both views read ONLY from the anon-readable public.reports table and run
--    with security_invoker = on, so they execute as the querying role (anon /
--    authenticated) against reports' own RLS — never bypassing it. They must
--    NOT read the RLS-protected scans table.
-- =============================================================================

-- Activity feed: "repos scanned recently", sourced from the public reports
-- table (NOT scans — scans is RLS-protected and the anon publishable key
-- cannot read it). Exposes only safe, public columns.
create or replace view public.v_activity
  with (security_invoker = on) as
  select
    r.owner_login,
    r.repo_name,
    r.score,
    r.verdict,
    r.created_at
  from public.reports r
  order by r.created_at desc
  limit 50;

-- Leaderboard: most dangerous repos only (score < 60 = the "Dangerous" band).
-- One row per (owner_login, repo_name) — the latest report for that repo —
-- then ordered worst-score-first.
create or replace view public.v_leaderboard
  with (security_invoker = on) as
  select
    latest.owner_login,
    latest.repo_name,
    latest.score,
    latest.verdict,
    latest.deep,
    latest.created_at
  from (
    select distinct on (r.owner_login, r.repo_name)
      r.owner_login,
      r.repo_name,
      r.score,
      r.verdict,
      r.deep,
      r.created_at
    from public.reports r
    where r.score < 60
    order by r.owner_login, r.repo_name, r.created_at desc
  ) as latest
  order by latest.score asc, latest.created_at desc
  limit 100;

-- =============================================================================
-- 8. RLS — enable and define policies
-- =============================================================================

-- ---------------------------------------------------------------------------
-- owners: public read, service-role write
-- ---------------------------------------------------------------------------
alter table public.owners enable row level security;

create policy "owners_public_read"
  on public.owners
  for select
  to anon, authenticated
  using (true);

create policy "owners_service_write"
  on public.owners
  for all
  to service_role
  using (true)
  with check (true);

-- ---------------------------------------------------------------------------
-- reports: public read, service-role write
-- ---------------------------------------------------------------------------
alter table public.reports enable row level security;

create policy "reports_public_read"
  on public.reports
  for select
  to anon, authenticated
  using (true);

create policy "reports_service_write"
  on public.reports
  for all
  to service_role
  using (true)
  with check (true);

-- ---------------------------------------------------------------------------
-- profiles: own-row read/update only; service-role full access
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;

create policy "profiles_own_read"
  on public.profiles
  for select
  to authenticated
  using ((select auth.uid()) = id);

create policy "profiles_own_update"
  on public.profiles
  for update
  to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

create policy "profiles_service_all"
  on public.profiles
  for all
  to service_role
  using (true)
  with check (true);

-- ---------------------------------------------------------------------------
-- scans: users read only their own rows; service-role writes
-- ---------------------------------------------------------------------------
alter table public.scans enable row level security;

create policy "scans_own_read"
  on public.scans
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "scans_service_all"
  on public.scans
  for all
  to service_role
  using (true)
  with check (true);

-- ---------------------------------------------------------------------------
-- scan_usage: no client access at all; service-role only (via the SECURITY
-- DEFINER function — clients never touch this table directly)
-- ---------------------------------------------------------------------------
alter table public.scan_usage enable row level security;

create policy "scan_usage_service_only"
  on public.scan_usage
  for all
  to service_role
  using (true)
  with check (true);

-- =============================================================================
-- 9. Revoke default public schema permissions
--    Supabase auto-expose is off (auto_expose_new_tables not set in config).
--    Belt-and-suspenders: explicitly revoke CREATE on public from public role.
-- =============================================================================
revoke create on schema public from public;

-- Grant only what each role needs
grant usage on schema public to anon, authenticated, service_role;

grant select on public.owners  to anon, authenticated;
grant select on public.reports to anon, authenticated;
grant select on public.v_activity    to anon, authenticated;
grant select on public.v_leaderboard to anon, authenticated;

grant select, update on public.profiles to authenticated;

-- service_role gets full access to all tables
grant all on public.owners     to service_role;
grant all on public.reports    to service_role;
grant all on public.profiles   to service_role;
grant all on public.scans      to service_role;
grant all on public.scan_usage to service_role;

-- Sequence grants for service_role (identity columns need nextval)
grant usage, select on all sequences in schema public to service_role;
