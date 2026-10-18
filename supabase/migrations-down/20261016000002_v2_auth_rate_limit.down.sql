-- Reverse of 20261016000002_v2_auth_rate_limit.sql (touches schema v2 only)
drop function if exists v2.redeem_oauth_code(text);
drop function if exists v2.create_oauth_code(uuid, text, text, text, text);
drop function if exists v2.register_oauth_client(text[]);
drop function if exists v2.cleanup_oauth();
drop table if exists v2.oauth_codes;
drop table if exists v2.oauth_clients;
drop function if exists v2.verify_cli_token(text);
drop function if exists v2.issue_cli_token(uuid);
drop table if exists v2.cli_tokens;
drop function if exists v2.check_scan_rate_limit(text, integer, integer);
drop table if exists v2.scan_rate_limit;
