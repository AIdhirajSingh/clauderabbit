-- =============================================================================
-- Clean fabricated seed data from the live DB (Phase 1 de-fake, extended).
--
-- Phase 1 de-faked the CODE (lib/demo-data.ts, supabase/seed.sql) but the LIVE
-- database retained the original invented demo/leaderboard rows from a PRIOR
-- seed (the danger board surfaced them once the board views went live). The
-- product's #1 rule is no invented data in any shipped path, so the de-fake must
-- reach the live data too — the board must show ONLY real scanned repos.
--
-- These rows are the invented personas/malware: verdant/ratchet,
-- ana-mirza/pomodoro-cli, marlow/envguard, quickdev/setup-helper,
-- corewallet/keystore-tools, fastlib/crypto-utils, and the fake dangerous
-- leaderboard (freebux/vbucks-generator, devkit/clipboard-sync,
-- npm-helper/postinstall-kit, ledger-connect/wallet-bridge,
-- talent-hub/frontend-take-home). Real scans (express, flask, requests, chalk,
-- commander.js, gorilla/mux, sindresorhus/*, octocat/*, zloirock/core-js,
-- openclaw, javascript-obfuscator, etc.) are KEPT.
--
-- IDEMPOTENT: on a fresh DB (whose seed is already de-faked) these DELETEs match
-- nothing and are harmless no-ops. ON DELETE SET NULL on the FKs means order does
-- not matter, but we delete scans -> reports -> owners for clarity.
-- =============================================================================

do $$
declare
  -- report/scan owner_login values used by the fabricated rows
  fake_report_owners text[] := array[
    'verdant','ana-mirza','marlow','quickdev','corewallet','fastlib',
    'freebux','devkit','npm-helper','ledger-connect','talent-hub'
  ];
  -- owner github_login values (the owners table used different handles than the
  -- report owner_login for some fabricated personas, e.g. soren-vestergaard).
  fake_owner_logins text[] := array[
    'soren-vestergaard','ana-mirza','marlow-dev','quickdev-tools',
    'corewallet-io','fastlib-pkg','freebux','devkit','npm-helper',
    'ledger-connect','talent-hub'
  ];
begin
  delete from public.scans   where owner_login  = any(fake_report_owners);
  delete from public.reports where owner_login  = any(fake_report_owners);
  delete from public.owners  where github_login = any(fake_owner_logins);
end $$;
