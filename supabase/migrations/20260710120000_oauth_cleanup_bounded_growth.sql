-- =============================================================================
-- Claude Rabbit — bound OAuth registration/code row growth
-- Migration: 20260710120000_oauth_cleanup_bounded_growth.sql
--
-- WHY THIS EXISTS:
--   /oauth/register (RFC 7591 Dynamic Client Registration) is, by spec, anon +
--   unauthenticated, so every call inserts an oauth_clients row. That makes
--   oauth_clients an unbounded-growth surface — both organically (a client is
--   registered per connector-add) and as a public-write ABUSE vector (a flood of
--   registrations, each a new row). oauth_codes has the mirror problem: an
--   authorization code that is issued but never redeemed (the user abandons the
--   flow) only EXPIRES, its row is never removed. Left alone, both tables grow
--   forever. See 20260704000002_oauth_for_remote_mcp.sql for the base schema.
--
-- THE FIX (safe + bounded, self-scheduling — pg_cron is NOT available on this
-- project, verified: pg_available_extensions.installed_version is null):
--   1. last_used_at — stamp a client the moment it is used to START a real,
--      AUTHENTICATED authorize flow (create_oauth_code). This is the signal that
--      separates a working connector from a registration that never logged anyone
--      in. NULL == never authorized == abandoned/abuse.
--   2. cleanup_oauth() — delete expired codes, and delete ONLY clients that were
--      NEVER used to authorize AND are older than a grace window. The
--      `last_used_at is null` guard is the safety rail: a client that ever
--      completed an authorize keeps its row forever, so cleanup can NEVER break a
--      live installed connector.
--   3. Run cleanup opportunistically (gated) from register_oauth_client, so the
--      tables are bounded exactly when they grow — no external scheduler needed.
--
-- Scope: ADDITIVE column + index, plus in-place (create-or-replace) function
-- updates. No column or row is dropped by the migration itself. Idempotent
-- (add column / create index IF NOT EXISTS; create or replace) so re-applying is
-- a no-op.
-- =============================================================================

-- 1. Heartbeat column: when was this client last used to START a real authorize
--    flow? NULL = registered but never authorized anyone (abandoned / abuse spam).
alter table public.oauth_clients
  add column if not exists last_used_at timestamptz;

-- Indexes backing the two cleanup deletes below (kept small; the client index is
-- PARTIAL — only the never-authorized rows cleanup ever scans).
create index if not exists oauth_codes_expires_at_idx
  on public.oauth_codes (expires_at);
create index if not exists oauth_clients_unused_idx
  on public.oauth_clients (created_at)
  where last_used_at is null;

-- 2. cleanup_oauth() — bounded, SAFE purge.
create or replace function public.cleanup_oauth()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Expired authorization codes are already invalid (the token exchange rejects
  -- anything past expires_at), so removing them changes no live behavior.
  delete from public.oauth_codes
    where expires_at < now();

  -- Clients that registered but NEVER completed a real authorize, older than the
  -- grace window. `last_used_at is null` is the safety rail: a client that ever
  -- authorized a user keeps its row forever, so no installed connector breaks.
  delete from public.oauth_clients
    where last_used_at is null
      and created_at < now() - interval '30 days';
end;
$$;

revoke all on function public.cleanup_oauth() from public, anon, authenticated;

-- 3. register_oauth_client: identical validation + insert as the base migration,
--    PLUS a self-throttling opportunistic GC. random() < 0.1 means a burst of
--    registrations does NOT each pay for a full sweep, yet the table stays bounded
--    because cleanup only needs to fire while the table is actively growing.
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

  -- Opportunistic, self-throttling GC: bound the tables exactly when they grow.
  if random() < 0.1 then
    perform public.cleanup_oauth();
  end if;

  v_client := 'cr_client_' || encode(extensions.gen_random_bytes(16), 'hex');

  insert into public.oauth_clients (client_id, redirect_uris)
  values (v_client, p_redirect_uris);

  return query select v_client;
end;
$$;

revoke all on function public.register_oauth_client(text[]) from public, authenticated;
grant execute on function public.register_oauth_client(text[]) to anon;

-- 4. create_oauth_code: unchanged logic, PLUS the heartbeat stamp so a connector
--    that actually logs someone in is permanently protected from cleanup.
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

  -- Heartbeat: this client just started a real, authenticated authorize flow, so
  -- it is a working connector and must never be reaped by cleanup_oauth().
  update public.oauth_clients
    set last_used_at = now()
    where client_id = p_client_id;

  v_code := 'cr_code_' || encode(extensions.gen_random_bytes(24), 'hex');

  insert into public.oauth_codes (code, user_id, client_id, redirect_uri, code_challenge, resource)
  values (v_code, v_user_id, p_client_id, p_redirect_uri, p_code_challenge, p_resource);

  return query select v_code;
end;
$$;

revoke all on function public.create_oauth_code(text, text, text, text) from public, anon;
grant execute on function public.create_oauth_code(text, text, text, text) to authenticated;

comment on function public.cleanup_oauth() is
  'Bounded GC for the remote-MCP OAuth tables: deletes expired oauth_codes and never-authorized oauth_clients older than 30 days. A client that ever completed an authorize (last_used_at set) is never deleted, so no installed connector is broken. Called opportunistically from register_oauth_client (no pg_cron on this project).';
