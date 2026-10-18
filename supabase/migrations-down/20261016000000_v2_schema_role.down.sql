-- Reverse of 20261016000000_v2_schema_role.sql. Run after the other v2 down
-- files. Removes schema v2 and the cr_v2_server role; nothing outside v2.
drop function if exists v2.touch_updated_at();
drop schema if exists v2;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'cr_v2_server') then
    drop owned by cr_v2_server;
    drop role cr_v2_server;
  end if;
end
$$;
