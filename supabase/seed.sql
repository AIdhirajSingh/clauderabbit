-- =============================================================================
-- Claude Rabbit — Seed Data
-- File: supabase/seed.sql  (referenced by config.toml [db.seed] sql_paths)
--
-- Inserts demo owners + reports from lib/demo-data.ts (REPOS r1,r6,r2,r3,r4,r5)
-- plus extra leaderboard-only rows and a handful of scan events so the
-- activity feed and leaderboard views return realistic data immediately.
--
-- Scores: 96 / 94 / 88 / 71 / 44 / 18  (green → blue → yellow → red spread)
-- Text is copied verbatim from demo-data.ts — do not summarise or invent.
-- =============================================================================

-- Use a savepoint so a single bad row does not abort the whole seed
begin;

-- ---------------------------------------------------------------------------
-- owners (6 demo + 4 leaderboard-only)
-- ---------------------------------------------------------------------------
insert into public.owners
  (github_login, display_name, account_age_label, established,
   public_repos, sentiment, sentiment_score, fetched_at)
values
  -- r1: verdant/ratchet
  ('soren-vestergaard',
   'Søren Vestergaard',
   '8 yr 2 mo',
   true,
   64,
   'Widely trusted, referenced across tutorials and production stacks.',
   96,
   now()),

  -- r6: ana-mirza/pomodoro-cli
  ('ana-mirza',
   'Ana Mirza',
   '3 yr 7 mo',
   true,
   21,
   'Small but clean personal project; no red flags found.',
   90,
   now()),

  -- r2: marlow/envguard
  ('marlow-dev',
   'Marlow Okonkwo',
   '1 yr 4 mo',
   true,
   9,
   'Positive, growing adoption; no complaints surfaced.',
   85,
   now()),

  -- r3: quickdev/setup-helper
  ('quickdev-tools',
   'quickdev',
   '3 days',
   false,
   1,
   'Sudden star spike inconsistent with account age; possible inflation.',
   48,
   now()),

  -- r4: corewallet/keystore-tools
  ('corewallet-io',
   'corewallet',
   '11 days',
   false,
   2,
   'A handful of issues report unexpected files and outbound traffic.',
   30,
   now()),

  -- r5: fastlib/crypto-utils
  ('fastlib-pkg',
   'fastlib',
   '2 days',
   false,
   1,
   'No legitimate references; name typosquats a popular package.',
   8,
   now()),

  -- leaderboard-only owners (no full report in this seed)
  ('freebux',      'freebux',        '5 days',   false, 1, null, null, now()),
  ('devkit',       'devkit',         '18 days',  false, 3, null, null, now()),
  ('npm-helper',   'npm-helper',     '7 days',   false, 2, null, null, now()),
  ('ledger-connect','ledger-connect','9 days',   false, 1, null, null, now()),
  ('talent-hub',   'talent-hub',     '14 days',  false, 2, null, null, now())

on conflict (github_login) do nothing;

-- ---------------------------------------------------------------------------
-- reports — full demo set (r1, r6, r2, r3, r4, r5)
-- ---------------------------------------------------------------------------

-- r1: verdant/ratchet — score 96 "Trusted"
insert into public.reports
  (owner_login, repo_name, commit_sha, ref,
   owner_id, score, verdict, cached, deep, summary,
   confidence, scan_path,
   stats_json, packages_json, risky_json, logs_json)
select
  'soren-vestergaard', 'ratchet', 'a91f3c0000000000000000000000000000000001', 'main',
  o.id,
  96, 'Trusted', true, false,
  'A mature HTTP router for Node. Built and ran cleanly in our static pass; no install hooks, no network calls at install, no credential access. Maintained by an established author with a long track record.',
  0.970, 'fast',
  '{"loc":"14,820","packages":7,"stars":"41.2k","created":"Mar 2018"}'::jsonb,
  '[
    {"name":"@verdant/ratchet","score":96,"note":"Core package. No suspicious calls."},
    {"name":"path-to-regexp","score":94,"note":"Well-known, actively maintained."},
    {"name":"negotiator","score":92,"note":"Stable dependency."}
  ]'::jsonb,
  '[]'::jsonb,
  '[
    {"ch":"Clone","kind":"ok","lines":["Resolved verdant/ratchet@a91f3c to commit SHA","Shallow clone complete · 14,820 lines across 96 files"]},
    {"ch":"Static scan","kind":"ok","lines":["ClamAV signatures: 0 hits","Semgrep patterns: 0 findings","YARA rules: 0 matches","No install hooks detected in package.json"]},
    {"ch":"Reputation","kind":"ok","lines":["Owner account age: 8 yr 2 mo","Brave search: 41.2k stars, strong community sentiment","Owner cache hit, skipped redundant lookup"]},
    {"ch":"Read","kind":"ok","lines":["Read model flagged regions: none","Confidence: 0.97 clean, no escalation","Verdict blended to 96 / 100"]}
  ]'::jsonb
from public.owners o
where o.github_login = 'soren-vestergaard'
on conflict (owner_login, repo_name, commit_sha) do nothing;

-- r6: ana-mirza/pomodoro-cli — score 94 "Trusted"
insert into public.reports
  (owner_login, repo_name, commit_sha, ref,
   owner_id, score, verdict, cached, deep, summary,
   confidence, scan_path,
   stats_json, packages_json, risky_json, logs_json)
select
  'ana-mirza', 'pomodoro-cli', '7d22b10000000000000000000000000000000002', 'main',
  o.id,
  94, 'Trusted', true, false,
  'A small personal Pomodoro timer for the terminal. Single dependency, no network activity, no install scripts. Clean, simple, and safe to run.',
  0.950, 'fast',
  '{"loc":"840","packages":2,"stars":"312","created":"Sep 2023"}'::jsonb,
  '[
    {"name":"pomodoro-cli","score":95,"note":"No network, no secrets access."},
    {"name":"chalk","score":93,"note":"Popular terminal color library."}
  ]'::jsonb,
  '[]'::jsonb,
  '[
    {"ch":"Clone","kind":"ok","lines":["Resolved ana-mirza/pomodoro-cli@7d22b1","Clone complete · 840 lines across 11 files"]},
    {"ch":"Static scan","kind":"ok","lines":["ClamAV: 0 · Semgrep: 0 · YARA: 0","No postinstall scripts"]},
    {"ch":"Reputation","kind":"ok","lines":["Account age 3 yr 7 mo · 21 repos","Low star count, but clean signal"]},
    {"ch":"Read","kind":"ok","lines":["No flagged regions","Confidence 0.95 clean, shipped to 94 / 100"]}
  ]'::jsonb
from public.owners o
where o.github_login = 'ana-mirza'
on conflict (owner_login, repo_name, commit_sha) do nothing;

-- r2: marlow/envguard — score 88 "Likely safe"
insert into public.reports
  (owner_login, repo_name, commit_sha, ref,
   owner_id, score, verdict, cached, deep, summary,
   confidence, scan_path,
   stats_json, packages_json, risky_json, logs_json)
select
  'marlow-dev', 'envguard', 'c4e8a00000000000000000000000000000000003', 'main',
  o.id,
  88, 'Likely safe', false, false,
  'A configuration and environment-variable validator. Code read cleanly and reputation is solid, but the owner account is younger and one dependency is lightly maintained. No malicious behavior observed in our tests.',
  0.880, 'fast',
  '{"loc":"3,210","packages":5,"stars":"3.4k","created":"Feb 2025"}'::jsonb,
  '[
    {"name":"@marlow/envguard","score":90,"note":"Clean. Reads process.env only, no exfil."},
    {"name":"dotenv","score":92,"note":"Ubiquitous, trusted."},
    {"name":"fast-deep-equal","score":88,"note":"Stable."},
    {"name":"tiny-glob","score":74,"note":"Lightly maintained, last release 14 mo ago."}
  ]'::jsonb,
  '[
    {"title":"Lightly maintained dependency","severity":"low","kind":"code","detail":"tiny-glob has had no release in 14 months. Not malicious, but unmaintained code is a standing risk."}
  ]'::jsonb,
  '[
    {"ch":"Clone","kind":"ok","lines":["Resolved marlow/envguard@c4e8a0","Clone complete · 3,210 lines across 38 files"]},
    {"ch":"Static scan","kind":"warn","lines":["ClamAV: 0 · YARA: 0","Semgrep: 1 low-severity note (unmaintained dep)","No install hooks"]},
    {"ch":"Reputation","kind":"ok","lines":["Account age 1 yr 4 mo · 3.4k stars","Brave search: positive sentiment, no incidents"]},
    {"ch":"Read","kind":"ok","lines":["Read flagged region (tiny-glob usage)","No exfil path · confidence 0.88 clean","No escalation, 88 / 100"]}
  ]'::jsonb
from public.owners o
where o.github_login = 'marlow-dev'
on conflict (owner_login, repo_name, commit_sha) do nothing;

-- r3: quickdev/setup-helper — score 71 "Caution" (deep run)
insert into public.reports
  (owner_login, repo_name, commit_sha, ref,
   owner_id, score, verdict, cached, deep, summary,
   confidence, scan_path,
   stats_json, packages_json, risky_json, logs_json)
select
  'quickdev-tools', 'setup-helper', 'f0192a0000000000000000000000000000000004', 'main',
  o.id,
  71, 'Caution', false, true,
  'A one-command project bootstrapper with a large postinstall script. We escalated to a sandbox run. The install script contacts a telemetry endpoint and writes outside the project directory. No credential theft observed, but the install-time behavior is more than this tool needs.',
  0.410, 'deep',
  '{"loc":"2,640","packages":6,"stars":"1.1k","created":"3 days ago"}'::jsonb,
  '[
    {"name":"setup-helper","score":62,"note":"Postinstall script writes to ~/.config and phones home."},
    {"name":"node-fetch","score":90,"note":"Legit, but used by the install hook."},
    {"name":"shelljs","score":70,"note":"Used to run shell commands during install."}
  ]'::jsonb,
  '[
    {"title":"Postinstall network call","severity":"med","kind":"behavior","detail":"During the sandbox run, the postinstall script sent a POST to telemetry.quickdev-cdn[.]net carrying machine hostname and npm config. Not credential theft, but undisclosed and unnecessary."},
    {"title":"Writes outside project root","severity":"med","kind":"behavior","detail":"Install wrote a launch agent to ~/.config/quickdev. Persistence behavior a bootstrapper does not need."},
    {"title":"Three-day-old owner","severity":"med","kind":"rep","detail":"Single polished repo on a brand-new account with an unnatural star spike."}
  ]'::jsonb,
  '[
    {"ch":"Clone","kind":"ok","lines":["Resolved quickdev/setup-helper@f0192a","Clone complete · 2,640 lines across 27 files"]},
    {"ch":"Static scan","kind":"warn","lines":["Semgrep: postinstall executes network + shell","Secret scan: 0 embedded secrets","Flagged: package.json scripts.postinstall"]},
    {"ch":"Reputation","kind":"warn","lines":["Account age: 3 days","Star spike vs age inconsistent, possible inflation","Confidence to ship: 0.41, escalate"]},
    {"ch":"Escalation","kind":"warn","lines":["Suspicion gate tripped: install-time network + new owner","Provisioning sandbox VM from pool"]},
    {"ch":"Dynamic run","kind":"warn","lines":["Agent ran npm install in isolated VM","Observed POST to telemetry.quickdev-cdn[.]net","Observed write to ~/.config/quickdev (launch agent)","No credential or SSH key access observed","VM reimaged to a clean state","Blended to 71 / 100"]}
  ]'::jsonb
from public.owners o
where o.github_login = 'quickdev-tools'
on conflict (owner_login, repo_name, commit_sha) do nothing;

-- r4: corewallet/keystore-tools — score 44 "High risk" (deep run)
insert into public.reports
  (owner_login, repo_name, commit_sha, ref,
   owner_id, score, verdict, cached, deep, summary,
   confidence, scan_path,
   stats_json, packages_json, risky_json, logs_json)
select
  'corewallet-io', 'keystore-tools', '2bd7e10000000000000000000000000000000005', 'main',
  o.id,
  44, 'High risk', false, true,
  'Marketed as a wallet keystore utility. In the sandbox it actively read SSH keys and shell history on first run. We could not verify any legitimate function that requires that access. Do not run this outside a throwaway environment.',
  0.220, 'deep',
  '{"loc":"4,910","packages":9,"stars":"680","created":"12 days ago"}'::jsonb,
  '[
    {"name":"keystore-tools","score":30,"note":"Reads ~/.ssh and shell history on import."},
    {"name":"keytar","score":55,"note":"Legit credential lib, used here to enumerate stored secrets."},
    {"name":"systeminformation","score":60,"note":"Used to fingerprint the host."}
  ]'::jsonb,
  '[
    {"title":"Reads SSH keys on run","severity":"high","kind":"behavior","detail":"Sandbox observed reads of ~/.ssh/id_ed25519 and ~/.ssh/known_hosts within 400ms of first execution. No feature here justifies that."},
    {"title":"Reads shell history","severity":"high","kind":"behavior","detail":"Accessed ~/.zsh_history and ~/.bash_history, a common credential-harvesting source."},
    {"title":"Host fingerprinting","severity":"med","kind":"behavior","detail":"Collected hostname, OS, and network interfaces via systeminformation, staged for an outbound call that the locked egress blocked."}
  ]'::jsonb,
  '[
    {"ch":"Clone","kind":"ok","lines":["Resolved corewallet/keystore-tools@2bd7e1","Clone complete · 4,910 lines across 52 files"]},
    {"ch":"Static scan","kind":"warn","lines":["Semgrep: filesystem reads of ~/.ssh path literals","YARA: matched credential-access heuristic","Confidence to ship: 0.22, escalate"]},
    {"ch":"Reputation","kind":"warn","lines":["Account age 11 days · wallet-adjacent repos","Issues mention unexpected files"]},
    {"ch":"Escalation","kind":"bad","lines":["Gate tripped: credential-access pattern","Sandbox VM provisioned"]},
    {"ch":"Dynamic run","kind":"bad","lines":["Observed read of ~/.ssh/id_ed25519","Observed read of ~/.zsh_history","Host fingerprint staged · outbound blocked by egress filter","VM reimaged to a clean state","Blended to 44 / 100"]}
  ]'::jsonb
from public.owners o
where o.github_login = 'corewallet-io'
on conflict (owner_login, repo_name, commit_sha) do nothing;

-- r5: fastlib/crypto-utils — score 18 "Malicious" (deep run)
insert into public.reports
  (owner_login, repo_name, commit_sha, ref,
   owner_id, score, verdict, cached, deep, summary,
   confidence, scan_path,
   stats_json, packages_json, risky_json, logs_json)
select
  'fastlib-pkg', 'crypto-utils', '9ee0a20000000000000000000000000000000006', 'main',
  o.id,
  18, 'Malicious', false, true,
  'Presented as a cryptography helper. The code is heavily obfuscated and on execution it began mining and attempted to reach a hardcoded command-and-control host. This is active install-time malware. Do not run.',
  0.040, 'deep',
  '{"loc":"1,180","packages":4,"stars":"94","created":"2 days ago"}'::jsonb,
  '[
    {"name":"crypto-utils","score":8,"note":"Obfuscated payload, base64 + eval. Miner + C2."},
    {"name":"node-fetch","score":88,"note":"Legit lib weaponized for C2 beacon."},
    {"name":"worker-farm","score":40,"note":"Spawns workers used for mining."}
  ]'::jsonb,
  '[
    {"title":"Obfuscated eval payload","severity":"high","kind":"code","detail":"Core module is a single base64 blob passed to eval(). Decoding revealed a miner and a beacon, a hallmark of install-time malware."},
    {"title":"Crypto-mining on run","severity":"high","kind":"behavior","detail":"Sandbox CPU pinned to 100% across worker-farm processes within seconds of execution."},
    {"title":"C2 beacon attempt","severity":"high","kind":"behavior","detail":"Repeated outbound to 185.x.x.x:8443 (hardcoded). Egress filter blocked it; the attempt is the detection."},
    {"title":"Typosquat name","severity":"high","kind":"rep","detail":"Name closely shadows a popular crypto package to catch fat-finger installs."}
  ]'::jsonb,
  '[
    {"ch":"Clone","kind":"ok","lines":["Resolved fastlib/crypto-utils@9ee0a2","Clone complete · 1,180 lines across 6 files"]},
    {"ch":"Static scan","kind":"bad","lines":["YARA: obfuscation + eval(base64) match","ClamAV: heuristic miner signature","Confidence to ship: 0.04, escalate"]},
    {"ch":"Reputation","kind":"bad","lines":["Account age 2 days · typosquat detected","No legitimate community references"]},
    {"ch":"Escalation","kind":"bad","lines":["Gate tripped: obfuscated payload + miner signature","Sandbox VM provisioned"]},
    {"ch":"Dynamic run","kind":"bad","lines":["eval() decoded to a miner + beacon","CPU 100% across worker-farm","Outbound to 185.x.x.x:8443 blocked","Repo attacked the sandbox, the attempt is the signal","VM reimaged to a clean state","Blended to 18 / 100"]}
  ]'::jsonb
from public.owners o
where o.github_login = 'fastlib-pkg'
on conflict (owner_login, repo_name, commit_sha) do nothing;

-- ---------------------------------------------------------------------------
-- Leaderboard-only reports (stub rows for repos shown in LEADERBOARD constant
-- but not in REPOS — freebux, devkit, npm-helper, ledger-connect, talent-hub)
-- These power the leaderboard view without requiring full log/package data.
-- ---------------------------------------------------------------------------
insert into public.reports
  (owner_login, repo_name, commit_sha, ref,
   owner_id, score, verdict, cached, deep, summary,
   confidence, scan_path,
   stats_json, packages_json, risky_json, logs_json)
select
  lb.owner_login, lb.repo_name, lb.fake_sha, 'main',
  o.id,
  lb.score, lb.verdict, false, true,
  lb.summary,
  0.020, 'deep',
  '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb
from (values
  ('freebux',       'vbucks-generator',   'dead000000000000000000000000000000000010',
   6,  'Malicious', 'Credential stealer disguised as a game tool.'),
  ('devkit',        'clipboard-sync',     'dead000000000000000000000000000000000011',
   9,  'Malicious', 'Replaces copied crypto addresses in the clipboard.'),
  ('npm-helper',    'postinstall-kit',    'dead000000000000000000000000000000000012',
   12, 'Malicious', 'Self-replicating worm, republishes through victims.'),
  ('ledger-connect','wallet-bridge',      'dead000000000000000000000000000000000013',
   15, 'Malicious', 'Drains wallet seed phrases at install time.'),
  ('talent-hub',    'frontend-take-home', 'dead000000000000000000000000000000000014',
   21, 'Malicious', 'Fake interview repo; harvests tokens on clone-and-run.')
) as lb(owner_login, repo_name, fake_sha, score, verdict, summary)
join public.owners o on o.github_login = lb.owner_login
on conflict (owner_login, repo_name, commit_sha) do nothing;

-- ---------------------------------------------------------------------------
-- scans — synthetic events so v_activity and dashboard history are non-empty
-- Uses service-role context; no user_id (public activity feed rows).
-- Timestamps spread over the last 10 minutes to mimic a live ticker.
-- ---------------------------------------------------------------------------
insert into public.scans
  (user_id, device_id, report_id, owner_login, repo_name,
   scan_path, score, status, is_dynamic, created_at)
select
  null,
  'seed-device-' || ev.ord,
  r.id,
  ev.owner_login,
  ev.repo_name,
  ev.scan_path,
  ev.score,
  'done',
  ev.is_dynamic,
  now() - (ev.offset_secs || ' seconds')::interval
from (values
  (1, 'soren-vestergaard', 'ratchet',       'fast',  96, false,   0),
  (2, 'fastlib-pkg',       'crypto-utils',  'deep',  18, true,   12),
  (3, 'marlow-dev',        'envguard',      'fast',  88, false,  40),
  (4, 'quickdev-tools',    'setup-helper',  'deep',  71, true,   60),
  (5, 'ana-mirza',         'pomodoro-cli',  'fast',  94, false, 120),
  (6, 'devkit',            'clipboard-sync','deep',   9, true,  180)
) as ev(ord, owner_login, repo_name, scan_path, score, is_dynamic, offset_secs)
join public.reports r
  on r.owner_login = ev.owner_login
 and r.repo_name   = ev.repo_name
on conflict do nothing;

commit;
