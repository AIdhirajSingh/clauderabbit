-- ClaudeRabbit 2.0: explicit deny policies on the v2 token tables (additive, schema v2 only).
--
-- v2.cli_tokens, v2.oauth_clients and v2.oauth_codes have RLS on and, until
-- this file, no policy at all: the deny was implicit, and the Supabase security
-- advisor reports each as "RLS enabled, no policy". No role holds a table grant
-- on them; cr_v2_server reaches them only through the security definer
-- functions in 20261016000002_v2_auth_rate_limit.sql, which run as the table
-- owner and so are not subject to these policies. Each policy below makes the
-- deny explicit for every role: a restrictive policy that is always false.
-- Behaviour is unchanged; the advisor finding is closed.
-- Reverse path: supabase/migrations-down/20261018000002_v2_token_tables_deny_policy.down.sql

create policy cli_tokens_no_direct_access on v2.cli_tokens
  as restrictive for all to public using (false) with check (false);

create policy oauth_clients_no_direct_access on v2.oauth_clients
  as restrictive for all to public using (false) with check (false);

create policy oauth_codes_no_direct_access on v2.oauth_codes
  as restrictive for all to public using (false) with check (false);
