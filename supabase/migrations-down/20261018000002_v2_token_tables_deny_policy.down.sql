-- Reverse of 20261018000002_v2_token_tables_deny_policy.sql (touches schema v2 only)
drop policy if exists cli_tokens_no_direct_access on v2.cli_tokens;
drop policy if exists oauth_clients_no_direct_access on v2.oauth_clients;
drop policy if exists oauth_codes_no_direct_access on v2.oauth_codes;
