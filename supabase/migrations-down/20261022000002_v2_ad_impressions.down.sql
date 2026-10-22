-- Reverse of 20261022000002_v2_ad_impressions.sql. Touches schema v2 only.
drop view if exists v2.scan_economics;
create view v2.scan_economics with (security_invoker = true) as
select
  r.id as run_id,
  r.subject,
  r.started_at,
  round(extract(epoch from (r.finished_at - r.started_at))::numeric, 1) as seconds,
  round(coalesce((r.cost ->> 'total_inr')::numeric, 0) * 100, 3) as cost_paise,
  r.ads_shown,
  s.ecpm_inr,
  round(r.ads_shown * s.ecpm_inr / 10, 3) as est_earnings_paise,
  case when r.finished_at > r.started_at
    then round(r.ads_shown * s.ecpm_inr / 10 / extract(epoch from (r.finished_at - r.started_at))::numeric, 4)
  end as est_paise_per_second
from v2.scan_runs r
cross join v2.ad_settings s;
revoke all on v2.scan_economics from anon, authenticated, service_role;
grant select on v2.scan_economics to cr_v2_server;
drop table if exists v2.scan_ad_impressions;
