-- =============================================================================
-- Defense-in-depth: v_board_dots materializes ONLY the geolocations array, never
-- the full forensics_json blob. (Security review MEDIUM, migration ...000003.)
--
-- v_board_dots returns only scalar geo fields to anon callers — it never projects
-- forensics_json, so there was no data leak. But its distinct-on subquery selected
-- the whole `r.forensics_json` blob and then discarded everything but the geo
-- array. On an anon-exposed view that blob should never be materialized at all.
-- This recreation projects `forensics_json #> '{network_intent,geolocations}'`
-- (the minimal slice the world map needs) inside the subquery, matching the design
-- intent stated in ...000001 ("NO full forensics blob is exposed; only the minimum
-- the map needs") and the column-stripping v_leaderboard_full already does.
--
-- Behaviour is identical to ...000003: latest-report-per-repo first, then
-- score<60 + a resolved country. Additive `create or replace view`.
-- =============================================================================

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
      -- minimal projection: only the geolocations slice is materialized here,
      -- never the full forensics blob (defense-in-depth on this anon view).
      (r.forensics_json #> '{network_intent,geolocations}') as geolocations
    from public.reports r
    order by r.owner_login, r.repo_name, r.created_at desc
  ) as latest
  cross join lateral jsonb_array_elements(
    coalesce(latest.geolocations, '[]'::jsonb)
  ) as geo
  where latest.score < 60
    and latest.geolocations is not null
    and nullif(trim(geo->>'country'), '') is not null;

grant select on public.v_board_dots to anon, authenticated;
