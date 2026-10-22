-- ClaudeRabbit 2.0: ad impressions per slot. Touches schema v2 only.
--
-- One row per counted impression: the run, the slot ('video', 'banner_1' to
-- 'banner_3', 'interstitial') and when. At most one per run and slot every 25 s
-- is counted (the store checks; every slot refreshes no faster than 30 s).
-- v2.scan_economics is rebuilt on it: ads by type, and the total including the
-- older v2.scan_runs.ads_shown counter for runs before this table.
-- Grants follow 20261016000001: RLS on, one permissive policy for cr_v2_server,
-- grants to cr_v2_server only.
--
-- Reverse path: supabase/migrations-down/20261022000002_v2_ad_impressions.down.sql

create table v2.scan_ad_impressions (
  id bigint generated always as identity primary key,
  run_id uuid not null references v2.scan_runs (id) on delete cascade,
  slot text not null check (slot in ('video', 'banner_1', 'banner_2', 'banner_3', 'interstitial')),
  at timestamptz not null default now()
);
create index scan_ad_impressions_run_slot on v2.scan_ad_impressions (run_id, slot, at desc);
alter table v2.scan_ad_impressions enable row level security;
create policy scan_ad_impressions_server_all on v2.scan_ad_impressions for all to cr_v2_server using (true) with check (true);
revoke all on v2.scan_ad_impressions from anon, authenticated, service_role;
grant select, insert on v2.scan_ad_impressions to cr_v2_server;

drop view v2.scan_economics;
create view v2.scan_economics with (security_invoker = true) as
with imp as (
  select run_id,
    count(*) filter (where slot = 'video') as video,
    count(*) filter (where slot like 'banner_%') as banner,
    count(*) filter (where slot = 'interstitial') as interstitial,
    count(*) as total
  from v2.scan_ad_impressions group by run_id
)
select
  r.id as run_id,
  r.subject,
  r.started_at,
  round(extract(epoch from (r.finished_at - r.started_at))::numeric, 1) as seconds,
  round(coalesce((r.cost ->> 'total_inr')::numeric, 0) * 100, 3) as cost_paise,
  coalesce(i.video, 0) as ads_video,
  coalesce(i.banner, 0) as ads_banner,
  coalesce(i.interstitial, 0) as ads_interstitial,
  r.ads_shown + coalesce(i.total, 0) as ads_shown,
  s.ecpm_inr,
  round((r.ads_shown + coalesce(i.total, 0)) * s.ecpm_inr / 10, 3) as est_earnings_paise,
  case when r.finished_at > r.started_at
    then round((r.ads_shown + coalesce(i.total, 0)) * s.ecpm_inr / 10 / extract(epoch from (r.finished_at - r.started_at))::numeric, 4)
  end as est_paise_per_second
from v2.scan_runs r
cross join v2.ad_settings s
left join imp i on i.run_id = r.id;
revoke all on v2.scan_economics from anon, authenticated, service_role;
grant select on v2.scan_economics to cr_v2_server;
