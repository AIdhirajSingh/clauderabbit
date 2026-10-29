-- ClaudeRabbit 2.0: revoke a user's CLI tokens. Touches schema v2 only.
--
-- v2.cli_token_cutoffs holds, per user, a time before which every CLI token
-- of that user is refused: v2 tokens and 1.0 tokens (public.cli_tokens) alike,
-- so a leaked token from either generation stops working without this
-- migration writing to a 1.0 object. v2.revoke_cli_tokens sets the cutoff
-- (it only ever moves forward) and stamps revoked_at on the v2 rows it covers.
-- v2.verify_cli_token is replaced to honour the cutoff; otherwise unchanged
-- from 20261016000002.
--
-- Reverse path: supabase/migrations-down/20261029000001_v2_cli_token_revocation.down.sql

create table v2.cli_token_cutoffs (
  user_id        uuid        primary key,
  revoked_before timestamptz not null,
  updated_at     timestamptz not null default now()
);
alter table v2.cli_token_cutoffs enable row level security;
create policy cli_token_cutoffs_no_direct_access on v2.cli_token_cutoffs
  as restrictive for all to public using (false) with check (false);
revoke all on v2.cli_token_cutoffs from public, anon, authenticated, service_role;

-- Refuse every CLI token of p_user_id issued before p_before. Returns how many
-- live v2 tokens it revoked (1.0 tokens are refused through the cutoff).
create or replace function v2.revoke_cli_tokens(p_user_id uuid, p_before timestamptz)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if p_user_id is null or p_before is null then
    raise exception 'revoke_cli_tokens: user and cutoff are required';
  end if;
  if p_before > now() + interval '1 minute' then
    raise exception 'revoke_cli_tokens: cutoff is in the future';
  end if;
  insert into v2.cli_token_cutoffs (user_id, revoked_before)
  values (p_user_id, p_before)
  on conflict (user_id) do update
     set revoked_before = greatest(v2.cli_token_cutoffs.revoked_before, excluded.revoked_before),
         updated_at = now();
  update v2.cli_tokens t
     set revoked_at = now()
   where t.user_id = p_user_id
     and t.revoked_at is null
     and t.created_at < p_before;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke execute on function v2.revoke_cli_tokens(uuid, timestamptz) from public;
grant  execute on function v2.revoke_cli_tokens(uuid, timestamptz) to cr_v2_server;

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
     and not exists (select 1 from v2.cli_token_cutoffs c
                      where c.user_id = t.user_id and t.created_at < c.revoked_before)
  returning t.user_id into v_user;

  if v_user is null and to_regclass('public.cli_tokens') is not null then
    select l.user_id into v_user
      from public.cli_tokens l
     where l.token_hash = v_hash
       and l.revoked_at is null
       and not exists (select 1 from v2.cli_token_cutoffs c
                        where c.user_id = l.user_id and l.created_at < c.revoked_before)
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
