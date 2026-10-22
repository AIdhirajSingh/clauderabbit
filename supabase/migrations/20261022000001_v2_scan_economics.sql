-- ClaudeRabbit 2.0: per-scan unit economics. Touches schema v2 only.
--
-- v2.scan_runs.ads_shown counts the GPT ad impressions rendered on the scan
-- screen for that run (fresh, stored or replayed), reported by /api/scan/ads; at
-- most one every 10 s per run is counted (ads_last_at), so the counter cannot be
-- driven faster than the slot refreshes. v2.ad_settings holds the estimated
-- eCPM (INR per 1,000 impressions, default 100). v2.scan_economics derives each
-- run's seconds, cost in paise, ads shown, estimated earnings and earnings per
-- second. Grants follow 20261016000001: RLS on, one permissive policy for
-- cr_v2_server, grants to cr_v2_server only; the existing grants and policy on
-- v2.scan_runs cover the new columns.
--
-- Reverse path: supabase/migrations-down/20261022000001_v2_scan_economics.down.sql

alter table v2.scan_runs add column ads_shown integer not null default 0 check (ads_shown >= 0);
alter table v2.scan_runs add column ads_last_at timestamptz;

create table v2.ad_settings (
  id smallint primary key default 1 check (id = 1),
  ecpm_inr numeric(10, 2) not null default 100 check (ecpm_inr >= 0),
  updated_at timestamptz not null default now()
);
insert into v2.ad_settings (id) values (1);
alter table v2.ad_settings enable row level security;
create policy ad_settings_server_all on v2.ad_settings for all to cr_v2_server using (true) with check (true);
revoke all on v2.ad_settings from anon, authenticated, service_role;
grant select, update on v2.ad_settings to cr_v2_server;

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
