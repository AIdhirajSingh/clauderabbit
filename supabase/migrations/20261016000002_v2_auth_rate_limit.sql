-- ClaudeRabbit 2.0: burst rate limit, CLI/MCP login tokens and the remote MCP
-- OAuth tables, all in schema v2 (DESIGN.md sections 4, 8.2).
--
-- 2.0 never writes a 1.0 table. Two read-only bridges keep existing users
-- working through the cutover, both SECURITY DEFINER functions that only
-- SELECT from 1.0:
--   v2.verify_cli_token    falls back to public.cli_tokens (hash lookup, no
--                          last_used_at stamp) so a token issued by 1.0 still
--                          signs the CLI and stdio MCP in;
--   v2.create_oauth_code   accepts a client registered in public.oauth_clients
--                          so an installed claude.ai connector keeps working.
-- Every new token, client and code is written to v2 only.
-- Reverse path: supabase/migrations-down/20261016000002_v2_auth_rate_limit.down.sql

-- ---------------------------------------------------------------------------
-- Burst rate limit: fixed tumbling window per bucket key (no daily quota).
-- ---------------------------------------------------------------------------
create table v2.scan_rate_limit (
  bucket_key    text        not null,
  window_start  timestamptz not null,
  request_count integer     not null default 0 check (request_count >= 0),
  created_at    timestamptz not null default now(),
  constraint pk_v2_scan_rate_limit primary key (bucket_key, window_start)
);

create index idx_v2_scan_rate_limit_window on v2.scan_rate_limit (window_start);

-- One atomic upsert-and-increment per request; prunes old windows on ~1% of calls.
create or replace function v2.check_scan_rate_limit(
  p_bucket_key     text,
  p_limit          integer,
  p_window_seconds integer
)
returns table (allowed boolean, current_count integer, retry_after integer)
language plpgsql
set search_path = ''
as $$
declare
  v_window_start timestamptz;
  v_next_window  timestamptz;
  v_count        integer;
begin
  if p_bucket_key is null or trim(p_bucket_key) = '' or length(p_bucket_key) > 200 then
    raise exception 'p_bucket_key must be a non-empty key of at most 200 characters';
  end if;
  if p_limit is null or p_limit < 1 then
    raise exception 'p_limit must be >= 1';
  end if;
  if p_window_seconds is null or p_window_seconds < 1 then
    raise exception 'p_window_seconds must be >= 1';
  end if;

  v_window_start := to_timestamp(floor(extract(epoch from clock_timestamp()) / p_window_seconds) * p_window_seconds);
  v_next_window  := v_window_start + make_interval(secs => p_window_seconds);

  insert into v2.scan_rate_limit as r (bucket_key, window_start, request_count)
  values (p_bucket_key, v_window_start, 1)
  on conflict (bucket_key, window_start)
  do update set request_count = r.request_count + 1
  returning r.request_count into v_count;

  if random() < 0.01 then
    delete from v2.scan_rate_limit
     where window_start < clock_timestamp() - make_interval(secs => p_window_seconds * 2);
  end if;

  return query select
    (v_count <= p_limit),
    v_count,
    greatest(1, ceil(extract(epoch from (v_next_window - clock_timestamp()))))::integer;
end;
$$;

revoke execute on function v2.check_scan_rate_limit(text, integer, integer) from public;
grant  execute on function v2.check_scan_rate_limit(text, integer, integer) to cr_v2_server;

-- ---------------------------------------------------------------------------
-- CLI / MCP login tokens. Only the SHA-256 hash is stored. user_id is the
-- auth.users id; it is checked against auth.users at issue and at verify
-- instead of a foreign key, so no trigger is added to auth.users.
-- ---------------------------------------------------------------------------
create table v2.cli_tokens (
  id           bigint      generated always as identity primary key,
  user_id      uuid        not null,
  token_hash   text        not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);

create index idx_v2_cli_tokens_user on v2.cli_tokens (user_id);

-- Issue a token for a user the server has already authenticated (Supabase
-- session JWT checked by the route). Returns the plaintext token exactly once.
create or replace function v2.issue_cli_token(p_user_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token text;
begin
  if p_user_id is null or not exists (select 1 from auth.users u where u.id = p_user_id) then
    raise exception 'issue_cli_token: unknown user';
  end if;
  v_token := 'cr_cli_' || encode(extensions.gen_random_bytes(32), 'hex');
  insert into v2.cli_tokens (user_id, token_hash)
  values (p_user_id, encode(extensions.digest(v_token, 'sha256'), 'hex'));
  return v_token;
end;
$$;

revoke execute on function v2.issue_cli_token(uuid) from public;
grant  execute on function v2.issue_cli_token(uuid) to cr_v2_server;

-- The owning user id of a live token, or null. v2 tokens get last_used_at
-- stamped; a 1.0 token is only read (public.cli_tokens is never written).
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

-- ---------------------------------------------------------------------------
-- Remote MCP OAuth 2.1 (RFC 7591 registration, PKCE codes).
-- ---------------------------------------------------------------------------
create table v2.oauth_clients (
  id            bigint      generated always as identity primary key,
  client_id     text        not null unique,
  redirect_uris text[]      not null,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz
);

create index idx_v2_oauth_clients_unused on v2.oauth_clients (created_at) where last_used_at is null;

create table v2.oauth_codes (
  code           text        primary key,
  user_id        uuid        not null,
  client_id      text        not null,
  redirect_uri   text        not null,
  code_challenge text        not null,
  resource       text,
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null default (now() + interval '5 minutes')
);

create index idx_v2_oauth_codes_expires on v2.oauth_codes (expires_at);

-- Expired codes and clients that never authorized anyone in 30 days.
create or replace function v2.cleanup_oauth()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from v2.oauth_codes where expires_at < now();
  delete from v2.oauth_clients where last_used_at is null and created_at < now() - interval '30 days';
end;
$$;

revoke execute on function v2.cleanup_oauth() from public;

create or replace function v2.register_oauth_client(p_redirect_uris text[])
returns table (client_id text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uri    text;
  v_client text;
begin
  if p_redirect_uris is null or array_length(p_redirect_uris, 1) is null then
    raise exception 'at least one redirect_uri is required';
  end if;
  if array_length(p_redirect_uris, 1) > 10 then
    raise exception 'at most 10 redirect_uris';
  end if;
  foreach v_uri in array p_redirect_uris loop
    if v_uri is null or length(v_uri) > 2048 or not (
      v_uri like 'https://%'
      or v_uri ~ '^http://127\.0\.0\.1(:[0-9]+)?(/|$)'
      or v_uri ~ '^http://localhost(:[0-9]+)?(/|$)'
    ) then
      raise exception 'redirect_uri must be https, or a loopback http address';
    end if;
  end loop;

  if random() < 0.1 then
    perform v2.cleanup_oauth();
  end if;

  v_client := 'cr_client_' || encode(extensions.gen_random_bytes(16), 'hex');
  insert into v2.oauth_clients (client_id, redirect_uris) values (v_client, p_redirect_uris);
  return query select v_client;
end;
$$;

revoke execute on function v2.register_oauth_client(text[]) from public;
grant  execute on function v2.register_oauth_client(text[]) to cr_v2_server;

-- Issue a 5-minute, single-use code to a user the server has authenticated.
create or replace function v2.create_oauth_code(
  p_user_id        uuid,
  p_client_id      text,
  p_redirect_uri   text,
  p_code_challenge text,
  p_resource       text
)
returns table (code text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ok   boolean := false;
  v_code text;
begin
  if p_user_id is null or not exists (select 1 from auth.users u where u.id = p_user_id) then
    raise exception 'create_oauth_code: unknown user';
  end if;
  if p_code_challenge is null or p_code_challenge !~ '^[A-Za-z0-9_-]{43,128}$' then
    raise exception 'a valid PKCE code_challenge (S256) is required';
  end if;

  update v2.oauth_clients c
     set last_used_at = now()
   where c.client_id = p_client_id
     and p_redirect_uri = any (c.redirect_uris);
  v_ok := found;

  if not v_ok and to_regclass('public.oauth_clients') is not null then
    select exists (
      select 1 from public.oauth_clients l
       where l.client_id = p_client_id
         and p_redirect_uri = any (l.redirect_uris)
    ) into v_ok;
  end if;

  if not v_ok then
    raise exception 'unknown client_id/redirect_uri pair';
  end if;

  v_code := 'cr_code_' || encode(extensions.gen_random_bytes(24), 'hex');
  insert into v2.oauth_codes (code, user_id, client_id, redirect_uri, code_challenge, resource)
  values (v_code, p_user_id, p_client_id, p_redirect_uri, p_code_challenge, p_resource);
  return query select v_code;
end;
$$;

revoke execute on function v2.create_oauth_code(uuid, text, text, text, text) from public;
grant  execute on function v2.create_oauth_code(uuid, text, text, text, text) to cr_v2_server;

-- Single use: the code row is deleted as it is read.
create or replace function v2.redeem_oauth_code(p_code text)
returns table (user_id uuid, client_id text, redirect_uri text, code_challenge text, expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
    delete from v2.oauth_codes c
     where c.code = p_code
    returning c.user_id, c.client_id, c.redirect_uri, c.code_challenge, c.expires_at;
end;
$$;

revoke execute on function v2.redeem_oauth_code(text) from public;
grant  execute on function v2.redeem_oauth_code(text) to cr_v2_server;

alter table v2.scan_rate_limit enable row level security;
alter table v2.cli_tokens      enable row level security;
alter table v2.oauth_clients   enable row level security;
alter table v2.oauth_codes     enable row level security;

-- The server role reaches tokens and OAuth rows only through the functions
-- above; it gets direct table access to the rate-limit counters alone.
create policy scan_rate_limit_server_all on v2.scan_rate_limit for all to cr_v2_server using (true) with check (true);
grant select, insert, update, delete on v2.scan_rate_limit to cr_v2_server;
