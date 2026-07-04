-- =============================================================================
-- Claude Rabbit — CLI/MCP login tokens
-- Migration: 20260704000001_cli_tokens.sql
--
-- WHY THIS EXISTS:
--   The CLI and MCP server now require a logged-in ClaudeRabbit user (a real
--   product/access decision, not a data-sensitivity one — the web app itself
--   stays fully anonymous-friendly, unaffected by this migration). Both tools
--   run as local processes with no browser session cookie, so they need a
--   long-lived, revocable bearer token distinct from the web app's Supabase
--   auth session.
--
--   Only the SHA-256 hash of each token is ever stored — the same principle as
--   a password hash. The plaintext token is generated and returned exactly
--   once, at issue time, directly to the authenticated browser session that
--   requested it (see issue_cli_token below); it is never persisted in
--   plaintext server-side and cannot be recovered if lost (the user just
--   issues a new one via a fresh `clauderabbit login`).
--
-- Scope: ADDITIVE only. Alters no prior migration's columns/functions/data.
-- =============================================================================

-- =============================================================================
-- 1. cli_tokens
--    One row per issued CLI/MCP login token. Written only via the
--    SECURITY DEFINER functions below (issue_cli_token / verify_cli_token) —
--    no direct client insert/update path exists.
-- =============================================================================
create table public.cli_tokens (
  id            bigint        generated always as identity primary key,
  user_id       uuid          not null references auth.users (id) on delete cascade,
  -- sha256(token), hex-encoded. The plaintext token is never stored.
  token_hash    text          not null unique,
  created_at    timestamptz   not null default now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);

create index idx_cli_tokens_user_id on public.cli_tokens (user_id);

-- Own-row read only (so a future "manage sessions" UI can list/revoke a
-- user's own tokens by id without ever exposing token_hash to other users).
-- No insert/update/delete policy for authenticated: those only happen through
-- the SECURITY DEFINER functions below, which bypass RLS by design.
alter table public.cli_tokens enable row level security;

create policy "cli_tokens_own_read"
  on public.cli_tokens
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "cli_tokens_service_all"
  on public.cli_tokens
  for all
  to service_role
  using (true)
  with check (true);

grant select on public.cli_tokens to authenticated;
grant all on public.cli_tokens to service_role;
grant usage, select on sequence public.cli_tokens_id_seq to service_role;

-- =============================================================================
-- 2. issue_cli_token()
--    Called by an ALREADY-AUTHENTICATED browser session (the /cli-auth page,
--    using the user's own Supabase session — auth.uid() comes from their JWT,
--    never a client-supplied user id). Generates a fresh random token, stores
--    only its hash, and returns the PLAINTEXT token exactly once.
-- =============================================================================
create or replace function public.issue_cli_token()
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_token   text;
begin
  if v_user_id is null then
    raise exception 'issue_cli_token requires an authenticated session';
  end if;

  -- 32 random bytes, hex-encoded (64 hex chars) — plenty of entropy for a
  -- bearer token; prefixed so a leaked token is recognizable as a ClaudeRabbit
  -- CLI credential (matches the pattern of the Supabase sb_publishable_ style
  -- prefixes this project already uses elsewhere).
  v_token := 'cr_cli_' || encode(extensions.gen_random_bytes(32), 'hex');

  insert into public.cli_tokens (user_id, token_hash)
  values (v_user_id, encode(extensions.digest(v_token, 'sha256'), 'hex'));

  return v_token;
end;
$$;

revoke all on function public.issue_cli_token() from public, anon;
grant execute on function public.issue_cli_token() to authenticated;

-- =============================================================================
-- 3. verify_cli_token(p_token)
--    Called by the scan edge function (service role) with the raw bearer
--    token from the CLI/MCP's Authorization header. Returns the owning
--    user_id, or null if the token is unknown/revoked. Updates last_used_at
--    on every successful verification (best-effort visibility only — never
--    used for anything security-relevant).
-- =============================================================================
create or replace function public.verify_cli_token(p_token text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
begin
  if p_token is null or length(p_token) = 0 then
    return null;
  end if;

  update public.cli_tokens
  set last_used_at = now()
  where token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')
    and revoked_at is null
  returning user_id into v_user_id;

  return v_user_id;
end;
$$;

revoke all on function public.verify_cli_token(text) from public, anon, authenticated;
grant execute on function public.verify_cli_token(text) to service_role;

comment on table public.cli_tokens is
  'CLI/MCP bearer login tokens. Hash-only storage (sha256); plaintext returned once at issue time via issue_cli_token(). Verified server-side (service role only) via verify_cli_token().';
