-- =============================================================================
-- Honest "deep sandbox runs" count (BUG-2/BUG-3, the canary).
--
-- v_board_stats.deep_repos counted the `deep` ESCALATION FLAG — a repo that
-- tripped the gate but was never actually executed (forensics_json NULL) still
-- inflated the board's "Deep sandbox runs" number (e.g. clawdcursor: deep=true,
-- no forensic record). The board must report only GENUINE executions, so the
-- count now reflects a present forensic record (the sandbox ran and produced
-- evidence), exactly matching the report page's Sandbox-run-vs-Static-read badge.
--
-- Same latest-per-repo basis as before; only the deep_repos definition changes
-- from `latest.deep` to "a forensic record exists". Additive `create or replace`.
-- =============================================================================

create or replace view public.v_board_stats
  with (security_invoker = on) as
  with latest as (
    select distinct on (r.owner_login, r.repo_name)
      r.owner_login,
      r.repo_name,
      r.score,
      -- the honest signal: the sandbox ran iff it left a forensic record
      (r.forensics_json is not null) as ran_sandbox
    from public.reports r
    order by r.owner_login, r.repo_name, r.created_at desc
  )
  select
    (select count(*) from latest)::bigint                          as distinct_repos,
    (select count(distinct r.owner_login) from public.reports r)::bigint
                                                                   as distinct_owners,
    (select count(*) from latest where latest.score < 60)::bigint  as dangerous_repos,
    -- Genuine sandbox executions only (forensic record present), NOT the bare
    -- `deep` escalation flag.
    (select count(*) from latest where latest.ran_sandbox)::bigint as deep_repos,
    (select count(*) from public.reports)::bigint                  as report_snapshots;

grant select on public.v_board_stats to anon, authenticated;
