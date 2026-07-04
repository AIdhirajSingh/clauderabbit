-- =============================================================================
-- Claude Rabbit — minimal OAuth 2.1 authorization server for the remote MCP
-- Migration: 20260704000002_oauth_for_remote_mcp.sql
--
-- WHY THIS EXISTS:
--   The remote (Streamable HTTP, Vercel-hosted) MCP server has no local
--   filesystem to share ~/.clauderabbit/credentials.json with, unlike the
--   stdio server. claude.ai's custom-connector auth expects a real OAuth 2.1
--   flow (RFC 8414 AS metadata, RFC 7591 dynamic client registration, PKCE).
--   This is the minimum real schema for that: register a client, issue a
--   short-lived authorization code to a SIGNED-IN browser session, then
--   redeem it (PKCE-verified) for a `cli_tokens` bearer token — reusing the
--   exact same token type/table the CLI and stdio MCP server already use, so
--   `verify_cli_token` (20260704000001_cli_tokens.sql) needs no changes.
--
-- Scope: ADDITIVE only. Alters no prior migration's columns/functions/data.
-- =============================================================================

-- =============================================================================
-- 1. oauth_clients — one row per Dynamic Client Registration (RFC 7591).
--    No client secret: MCP clients are public clients using PKCE, not
--    confidential clients, so there is nothing secret to protect here.
-- =============================================================================
create table public.oauth_clients (
  id            bigint        generated always as identity primary key,
  client_id     text          not null unique,
  redirect_uris text[]        not null,
  created_at    timestamptz   not null default now()
);

alter table public.oauth_clients enable row level security;

create policy "oauth_clients_service_all"
  on public.oauth_clients
  for all
  to service_role
  using (true)
  with check (true);

grant all on public.oauth_clients to service_role;
grant usage, select on sequence public.oauth_clients_id_seq to service_role;

-- =============================================================================
-- 2. oauth_codes — one row per issued authorization code. Short-lived
--    (5 minutes) and single-use (deleted by the token exchange). Holds the
--    PKCE code_challenge, never the verifier.
-- =============================================================================
create table public.oauth_codes (
  code            text          primary key,
  user_id         uuid          not null references auth.users (id) on delete cascade,
  client_id       text          not null,
  redirect_uri    text          not null,
  code_challenge  text          not null,
  resource        text,
  created_at      timestamptz   not null default now(),
  expires_at      timestamptz   not null default (now() + interval '5 minutes')
);

alter table public.oauth_codes enable row level security;

create policy "oauth_codes_service_all"
  on public.oauth_codes
  for all
  to service_role
  using (true)
  with check (true);

grant all on public.oauth_codes to service_role;

-- =============================================================================
-- 3. register_oauth_client(p_redirect_uris)
--    Dynamic Client Registration (RFC 7591) is, by definition, called by a
--    brand-new MCP client with no user or session yet — anon-callable.
--    Redirect URIs are validated (https, or loopback for a local dev client)
--    so a malicious registration can't later be used to redirect a real
--    user's authorization code somewhere unexpected.
-- =============================================================================
create or replace function public.register_oauth_client(p_redirect_uris text[])
returns table (client_id text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uri      text;
  v_client   text;
begin
  if p_redirect_uris is null or array_length(p_redirect_uris, 1) is null then
    raise exception 'at least one redirect_uri is required';
  end if;

  foreach v_uri in array p_redirect_uris loop
    if not (
      v_uri like 'https://%'
      or v_uri like 'http://127.0.0.1%'
      or v_uri like 'http://localhost%'
    ) then
      raise exception 'redirect_uri must be https, or a loopback http address: %', v_uri;
    end if;
  end loop;

  v_client := 'cr_client_' || encode(extensions.gen_random_bytes(16), 'hex');

  insert into public.oauth_clients (client_id, redirect_uris)
  values (v_client, p_redirect_uris);

  return query select v_client;
end;
$$;

revoke all on function public.register_oauth_client(text[]) from public, authenticated;
grant execute on function public.register_oauth_client(text[]) to anon;

-- =============================================================================
-- 4. create_oauth_code(p_client_id, p_redirect_uri, p_code_challenge, p_resource)
--    Called by an ALREADY-AUTHENTICATED browser session (the /oauth/authorize
--    page) — auth.uid() from the user's own JWT, never a client-supplied
--    user id. Validates the client_id/redirect_uri pair was really
--    registered (closing the open-redirect hole DCR would otherwise open).
-- =============================================================================
create or replace function public.create_oauth_code(
  p_client_id text,
  p_redirect_uri text,
  p_code_challenge text,
  p_resource text
)
returns table (code text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_code    text;
  v_ok      boolean;
begin
  if v_user_id is null then
    raise exception 'create_oauth_code requires an authenticated session';
  end if;
  if p_code_challenge is null or length(p_code_challenge) < 43 then
    raise exception 'a valid PKCE code_challenge (S256) is required';
  end if;

  select exists (
    select 1 from public.oauth_clients
    where client_id = p_client_id
      and p_redirect_uri = any (redirect_uris)
  ) into v_ok;

  if not v_ok then
    raise exception 'unknown client_id/redirect_uri pair';
  end if;

  v_code := 'cr_code_' || encode(extensions.gen_random_bytes(24), 'hex');

  insert into public.oauth_codes (code, user_id, client_id, redirect_uri, code_challenge, resource)
  values (v_code, v_user_id, p_client_id, p_redirect_uri, p_code_challenge, p_resource);

  return query select v_code;
end;
$$;

revoke all on function public.create_oauth_code(text, text, text, text) from public, anon;
grant execute on function public.create_oauth_code(text, text, text, text) to authenticated;

comment on table public.oauth_clients is
  'Dynamically-registered OAuth clients (RFC 7591) for the remote MCP server. Public clients only (PKCE, no secret).';
comment on table public.oauth_codes is
  'Short-lived (5 min), single-use OAuth authorization codes for the remote MCP server login flow. Redeemed by the oauth-token edge function, which mints a cli_tokens row on success.';
