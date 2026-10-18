-- ClaudeRabbit 2.0: daily spend floor in schema v2 (DESIGN.md section 7.1 item 3).
-- One row per UTC day with the sandbox seconds and model tokens spent. The
-- engine checks the caps before a fresh scan and charges the usage after it.
-- Reverse path: supabase/migrations-down/20261016000003_v2_scan_budget.down.sql

create table v2.scan_budget (
  day             date   primary key,
  sandbox_seconds bigint not null default 0 check (sandbox_seconds >= 0),
  model_tokens    bigint not null default 0 check (model_tokens >= 0)
);

-- Returns false (and applies nothing) when today is already at or over either
-- cap; otherwise adds the charge and returns true. A zero charge is a pure check.
create or replace function v2.scan_budget_charge(
  p_sandbox_seconds integer,
  p_tokens          integer,
  p_cap_seconds     integer,
  p_cap_tokens      integer
)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_day date := (now() at time zone 'utc')::date;
  v_row v2.scan_budget%rowtype;
begin
  if p_sandbox_seconds is null or p_sandbox_seconds < 0 or p_tokens is null or p_tokens < 0 then
    raise exception 'charges must be non-negative';
  end if;
  if p_cap_seconds is null or p_cap_seconds < 1 or p_cap_tokens is null or p_cap_tokens < 1 then
    raise exception 'caps must be >= 1';
  end if;

  insert into v2.scan_budget (day) values (v_day) on conflict (day) do nothing;
  select * into v_row from v2.scan_budget where day = v_day for update;

  if v_row.sandbox_seconds >= p_cap_seconds or v_row.model_tokens >= p_cap_tokens then
    return false;
  end if;

  update v2.scan_budget
     set sandbox_seconds = sandbox_seconds + p_sandbox_seconds,
         model_tokens    = model_tokens + p_tokens
   where day = v_day;
  return true;
end;
$$;

revoke execute on function v2.scan_budget_charge(integer, integer, integer, integer) from public;
grant  execute on function v2.scan_budget_charge(integer, integer, integer, integer) to cr_v2_server;

alter table v2.scan_budget enable row level security;
create policy scan_budget_server_all on v2.scan_budget for all to cr_v2_server using (true) with check (true);
grant select, insert, update on v2.scan_budget to cr_v2_server;
