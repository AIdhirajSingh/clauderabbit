-- ClaudeRabbit 2.0: scanning has no daily quota (CLAUDE.md V1 scope); the
-- unused daily-cap function and its table are removed. The burst floor
-- (check_scan_rate_limit) stays.
-- Reverse path: supabase/migrations-post-cutover/20261016000005_drop_dead_quota.down.sql

drop function if exists public.check_and_increment_scan_limit(uuid, text, text);
drop table if exists public.scan_usage;
