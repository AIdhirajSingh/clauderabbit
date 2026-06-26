-- =============================================================================
-- Claude Rabbit — Danger-board aggregates (Phase 5)
-- Migration: 20260627000001_board_aggregates.sql
--
-- Adds the read-only, anon-safe views the comprehensive danger board reads:
--   - v_leaderboard_full   : the paginated ranked list of caught (score<60)
--                            repos, latest-per-repo, with a FULLY DETERMINISTIC
--                            order so offset/range pagination never drops or
--                            duplicates a row.
--   - v_board_stats        : honest live counts (distinct repos / owners /
--                            dangerous repos / deep runs) — sourced ONLY from the
--                            anon-readable reports cache, with precise meanings.
--   - v_score_distribution : the latest-per-repo score-band histogram driving the
--                            chart. Shares the SAME latest-per-repo basis as the
--                            stats so the chart, counts, and list never contradict.
--   - v_board_dots         : lightweight geo for the world map — country + band +
--                            host per caught repo, derived from the forensic
--                            network-intent geolocations. NO full forensics blob is
--                            exposed; only the minimum the map needs.
--
-- All four views run with security_invoker = on and read ONLY public.reports
-- (anon select using(true)). They NEVER read the RLS-protected public.scans
-- table. ADDITIVE only — nothing is dropped or altered. Honesty rails:
--   * Counts are SHA-cache facts, labelled precisely (no "scans performed" — that
--     would need the RLS-protected scans table; we do not fabricate it).
--   * The board is score<60 only (the Dangerous band); reputation is never blended.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Shared basis: the latest report per (owner_login, repo_name). Inlined into
-- each view below (Postgres has no shared-CTE-across-views), but every view uses
-- the IDENTICAL distinct-on shape so all board surfaces agree.
-- ---------------------------------------------------------------------------

-- v_leaderboard_full — the full ranked danger list (caught repos), paginated by
-- the caller via .range(). Latest report per repo, score<60, ordered worst-first
-- with a deterministic unique tiebreak (owner_login, repo_name) so range
-- pagination is stable across pages and live inserts.
create or replace view public.v_leaderboard_full
  with (security_invoker = on) as
  select
    latest.owner_login,
    latest.repo_name,
    latest.score,
    latest.verdict,
    latest.deep,
    latest.commit_sha,
    latest.created_at,
    latest.forensics_json
  from (
    select distinct on (r.owner_login, r.repo_name)
      r.owner_login,
      r.repo_name,
      r.score,
      r.verdict,
      r.deep,
      r.commit_sha,
      r.created_at,
      r.forensics_json
    from public.reports r
    where r.score < 60
    order by r.owner_login, r.repo_name, r.created_at desc
  ) as latest
  order by latest.score asc, latest.created_at desc,
           latest.owner_login asc, latest.repo_name asc;

-- v_board_dots — minimal world-map geo for caught repos. One row per
-- (repo, captured destination country) we actually resolved off-VM. Exposes
-- ONLY: repo identity, score, and the geolocation fields (country/region/city/
-- org/host). No forensics blob, no payloads. A repo with no resolved geo
-- contributes no row (honest: no fake dots).
create or replace view public.v_board_dots
  with (security_invoker = on) as
  select
    latest.owner_login,
    latest.repo_name,
    latest.score,
    nullif(trim(geo->>'country'), '') as country,
    nullif(trim(geo->>'region'), '')  as region,
    nullif(trim(geo->>'city'), '')    as city,
    nullif(trim(geo->>'org'), '')     as org,
    nullif(trim(geo->>'host'), '')    as host
  from (
    select distinct on (r.owner_login, r.repo_name)
      r.owner_login,
      r.repo_name,
      r.score,
      r.forensics_json
    from public.reports r
    where r.score < 60
      and r.forensics_json is not null
    order by r.owner_login, r.repo_name, r.created_at desc
  ) as latest
  cross join lateral jsonb_array_elements(
    coalesce(latest.forensics_json #> '{network_intent,geolocations}', '[]'::jsonb)
  ) as geo
  -- Only keep a dot when a country was actually resolved (real geo, not a guess).
  where nullif(trim(geo->>'country'), '') is not null;

-- v_board_stats — honest live counts, single row. Every counter is a precise,
-- defensible fact about the anon-readable reports cache. Counters that would
-- require the RLS-protected scans table (e.g. "scans performed", "concurrent
-- VMs running") are deliberately OMITTED rather than fabricated.
create or replace view public.v_board_stats
  with (security_invoker = on) as
  with latest as (
    select distinct on (r.owner_login, r.repo_name)
      r.owner_login,
      r.repo_name,
      r.score,
      r.deep
    from public.reports r
    order by r.owner_login, r.repo_name, r.created_at desc
  )
  select
    -- Distinct repositories that have a cached report (the accumulating asset).
    (select count(*) from latest)::bigint                          as distinct_repos,
    -- Distinct owners across all cached reports.
    (select count(distinct r.owner_login) from public.reports r)::bigint
                                                                   as distinct_owners,
    -- Repos whose latest verdict is in the Dangerous band (score<60) — matches
    -- exactly what v_leaderboard_full lists.
    (select count(*) from latest where latest.score < 60)::bigint  as dangerous_repos,
    -- Repos whose latest report came from a deep (dynamic sandbox) run.
    (select count(*) from latest where latest.deep)::bigint        as deep_repos,
    -- Total cached report snapshots (one per owner/repo/commit SHA). Labelled in
    -- the UI as "repo snapshots cached", never as "scans performed".
    (select count(*) from public.reports)::bigint                  as report_snapshots;

-- v_score_distribution — the latest-per-repo score-band histogram. Same latest
-- basis as v_board_stats, so the chart and the counts cannot disagree.
create or replace view public.v_score_distribution
  with (security_invoker = on) as
  with latest as (
    select distinct on (r.owner_login, r.repo_name)
      r.owner_login,
      r.repo_name,
      r.score
    from public.reports r
    order by r.owner_login, r.repo_name, r.created_at desc
  )
  select
    count(*) filter (where score < 60)               ::bigint as red_count,
    count(*) filter (where score >= 60 and score < 80)::bigint as amber_count,
    count(*) filter (where score >= 80 and score < 90)::bigint as blue_count,
    count(*) filter (where score >= 90)              ::bigint as green_count
  from latest;

-- ---------------------------------------------------------------------------
-- Grants — anon + authenticated may read all four board views (public surface).
-- ---------------------------------------------------------------------------
grant select on public.v_leaderboard_full  to anon, authenticated;
grant select on public.v_board_dots        to anon, authenticated;
grant select on public.v_board_stats       to anon, authenticated;
grant select on public.v_score_distribution to anon, authenticated;
