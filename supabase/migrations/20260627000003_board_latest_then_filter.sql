-- =============================================================================
-- Fix v_leaderboard_full + v_board_dots: take the LATEST report per repo FIRST,
-- THEN filter score<60. (Bug found by the live board proof.)
--
-- The original views applied `where score < 60` INSIDE the distinct-on, so a repo
-- whose LATEST report is safe but which had an EARLIER dangerous scan (e.g.
-- expressjs/morgan: an old 41 before the static-scan precision fix, now 93) would
-- wrongly appear on the danger board with the stale dangerous score — and would
-- contradict v_board_stats (which already filters AFTER latest-per-repo, so it
-- correctly reported 0 dangerous). v_board_stats and v_score_distribution were
-- already correct; only these two needed the fix. After this, the danger board
-- reflects each repo's LATEST verdict only, consistent across list/dots/stats.
--
-- Additive: `create or replace view` — no schema/data change.
-- =============================================================================

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
    -- defense-in-depth: bulk list does not need the decoded-payload blob
    (latest.forensics_json - 'payload_analysis') as forensics_json
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
    order by r.owner_login, r.repo_name, r.created_at desc
  ) as latest
  where latest.score < 60
  order by latest.score asc, latest.created_at desc,
           latest.owner_login asc, latest.repo_name asc;

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
    order by r.owner_login, r.repo_name, r.created_at desc
  ) as latest
  cross join lateral jsonb_array_elements(
    coalesce(latest.forensics_json #> '{network_intent,geolocations}', '[]'::jsonb)
  ) as geo
  where latest.score < 60
    and latest.forensics_json is not null
    and nullif(trim(geo->>'country'), '') is not null;

grant select on public.v_leaderboard_full to anon, authenticated;
grant select on public.v_board_dots       to anon, authenticated;
