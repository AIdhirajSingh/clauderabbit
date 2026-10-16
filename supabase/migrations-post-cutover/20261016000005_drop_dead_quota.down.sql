-- Reverse of 20261016000005_drop_dead_quota.sql: the original DDL from 20260625000001 and 20260625000002, comments removed.
create table public.scan_usage (
  id              bigint    generated always as identity primary key,
  user_id         uuid      references auth.users (id) on delete cascade,
  device_id       text,
  usage_day       date      not null,
  stage1_count    integer   not null default 0 check (stage1_count >= 0),
  dynamic_count   integer   not null default 0 check (dynamic_count >= 0),

  constraint uq_scan_usage_user_day
    unique (user_id, usage_day),
  constraint uq_scan_usage_device_day
    unique (device_id, usage_day),
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

create or replace function public.check_and_increment_scan_limit(
  p_user_id   uuid,
  p_device_id text,
  p_scan_type text
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

revoke execute on function public.check_and_increment_scan_limit(uuid, text, text)
  from public, anon, authenticated;

alter table public.scan_usage enable row level security;

create policy "scan_usage_service_only"
  on public.scan_usage
  for all
  to service_role
  using (true)
  with check (true);

grant all on public.scan_usage to service_role;
grant execute on function public.check_and_increment_scan_limit(uuid, text, text)
  to service_role;
