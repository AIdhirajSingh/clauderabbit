-- Reverse of 20261029000001_v2_cli_token_revocation.sql (touches schema v2 only).
-- Restores v2.verify_cli_token as 20261016000002 defined it.
drop function if exists v2.revoke_cli_tokens(uuid, timestamptz);

create or replace function v2.verify_cli_token(p_token text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hash text;
  v_user uuid;
begin
  if p_token is null or p_token !~ '^cr_cli_[0-9a-f]{64}$' then
    return null;
  end if;
  v_hash := encode(extensions.digest(p_token, 'sha256'), 'hex');

  update v2.cli_tokens t
     set last_used_at = now()
   where t.token_hash = v_hash
     and t.revoked_at is null
  returning t.user_id into v_user;

  if v_user is null and to_regclass('public.cli_tokens') is not null then
    select l.user_id into v_user
      from public.cli_tokens l
     where l.token_hash = v_hash
       and l.revoked_at is null
     limit 1;
  end if;

  if v_user is null or not exists (select 1 from auth.users u where u.id = v_user) then
    return null;
  end if;
  return v_user;
end;
$$;

revoke execute on function v2.verify_cli_token(text) from public;
grant  execute on function v2.verify_cli_token(text) to cr_v2_server;

drop table if exists v2.cli_token_cutoffs;
