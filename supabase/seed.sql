-- =============================================================================
-- Claude Rabbit — Seed Data
-- File: supabase/seed.sql  (referenced by config.toml [db.seed] sql_paths)
--
-- Seeds the database with REAL scan results captured verbatim from the live
-- `scan` edge function for famous public GitHub repositories across multiple
-- owners (expressjs, pallets, psf, chalk, tj, gorilla, sindresorhus). Scores,
-- summaries, owner history, reputation, risky findings, scan logs, and commit
-- SHAs are exactly what the scanner returned — nothing here is invented.
--
-- These mirror lib/demo-data.ts so the public report surface, activity feed,
-- and dashboard history return real data immediately. There is NO dangerous-
-- repos seed: every real famous repo scores safe, and we do not fabricate
-- malware rows. The danger board (v_leaderboard) populates from real low-
-- scoring scans over time.
--
-- Scores: 98 / 98 / 98 / 98 / 98 / 95  (all in the green "secure" band)
-- =============================================================================

begin;

-- ---------------------------------------------------------------------------
-- owners — real GitHub owners (reputation as returned by the live scan)
-- ---------------------------------------------------------------------------
insert into public.owners
  (github_login, display_name, account_age_label, established,
   public_repos, sentiment, sentiment_score, fetched_at)
values
  ('expressjs',
   'Express.js Organization',
   '12 yr 8 mo',
   true,
   49,
   'Extremely positive, industry standard',
   100,
   now()),

  ('pallets',
   'Pallets',
   '10 yr 5 mo',
   true,
   17,
   'Excellent',
   100,
   now()),

  ('psf',
   'Python Software Foundation',
   '7 yr 1 mo',
   true,
   42,
   'Excellent',
   100,
   now()),

  ('chalk',
   'chalk',
   '10 yr 12 mo',
   true,
   16,
   'Extremely positive community standing',
   100,
   now()),

  ('tj',
   'TJ',
   '17 yr 9 mo',
   true,
   296,
   'Extremely positive',
   100,
   now()),

  ('gorilla',
   'Gorilla web toolkit',
   '15 yr 7 mo',
   true,
   19,
   'Excellent',
   100,
   now()),

  ('sindresorhus',
   'Sindre Sorhus',
   '16 yr 6 mo',
   true,
   1134,
   'Excellent',
   100,
   now())

on conflict (github_login) do nothing;

-- ---------------------------------------------------------------------------
-- reports — real famous-repo scans (verbatim from the live scan function)
-- ---------------------------------------------------------------------------

-- expressjs/express — score 98 "Trusted"
insert into public.reports
  (owner_login, repo_name, commit_sha, ref,
   owner_id, score, verdict, cached, deep, summary,
   confidence, scan_path,
   stats_json, packages_json, risky_json, logs_json)
select
  'expressjs', 'express', '18e5985b8a9d5e8423db0a9121f22bdaecd5b120', 'main',
  o.id,
  98, 'Trusted', true, false,
  'Express.js is a foundational, industry-standard web framework for Node.js. The static analysis of the provided files revealed no malicious patterns, obfuscation, or suspicious network activity. While this repository is highly trusted, please note that this assessment is based on a static read of the provided files; full runtime behavior was not executed in a sandbox on this pass.',
  0.950, 'fast',
  '{"loc":"9880 KB","packages":0,"stars":"69242","created":"12 yr 8 mo ago"}'::jsonb,
  '[]'::jsonb,
  '[]'::jsonb,
  '[
    {"ch":"Clone","kind":"ok","lines":["Cloned repository expressjs/express at commit 18e5985b8a9d5e8423db0a9121f22bdaecd5b120"]},
    {"ch":"Static scan","kind":"ok","lines":["Scanned 15 files for malicious patterns","No flagged regions or suspicious code found"]},
    {"ch":"Reputation","kind":"ok","lines":["Owner expressjs is a well-established organization","Repository has significant community backing (69k+ stars)"]},
    {"ch":"Read","kind":"ok","lines":["Code structure consistent with standard Express.js framework patterns","No obfuscation or hidden network calls detected"]}
  ]'::jsonb
from public.owners o
where o.github_login = 'expressjs'
on conflict (owner_login, repo_name, commit_sha) do nothing;

-- pallets/flask — score 98 "Trusted"
insert into public.reports
  (owner_login, repo_name, commit_sha, ref,
   owner_id, score, verdict, cached, deep, summary,
   confidence, scan_path,
   stats_json, packages_json, risky_json, logs_json)
select
  'pallets', 'flask', '36e4a824f340fdee7ed50937ba8e7f6bc7d17f81', 'main',
  o.id,
  98, 'Trusted', true, false,
  'Flask is a highly established, industry-standard Python web framework maintained by the Pallets organization. The static scan identified hardcoded local loopback addresses (127.0.0.1) in documentation examples, which are standard for local development instructions and pose no security risk. No malicious behavior was observed in our static read; full runtime behavior was not executed in a sandbox on this pass.',
  0.950, 'fast',
  '{"loc":"12008 KB","packages":0,"stars":"71734","created":"10 yr 5 mo"}'::jsonb,
  '[]'::jsonb,
  '[
    {"title":"Hardcoded local loopback address in documentation","severity":"low","kind":"code","detail":"Documentation examples reference 127.0.0.1:5000 for local development testing, which is standard practice and not a security vulnerability."}
  ]'::jsonb,
  '[
    {"ch":"Clone","kind":"ok","lines":["Cloned repository pallets/flask at commit 36e4a824f340fdee7ed50937ba8e7f6bc7d17f81"]},
    {"ch":"Reputation","kind":"ok","lines":["Owner ''pallets'' is a well-known, established entity in the Python ecosystem.","High star count and long account history indicate high trust."]},
    {"ch":"Static scan","kind":"ok","lines":["No malicious patterns, obfuscation, or unauthorized network calls detected.","Flagged regions identified as standard documentation for local development."]},
    {"ch":"Read","kind":"ok","lines":["Analyzed 15 files including READMEs and examples.","All flagged items are benign references to localhost."]}
  ]'::jsonb
from public.owners o
where o.github_login = 'pallets'
on conflict (owner_login, repo_name, commit_sha) do nothing;

-- psf/requests — score 98 "Trusted"
insert into public.reports
  (owner_login, repo_name, commit_sha, ref,
   owner_id, score, verdict, cached, deep, summary,
   confidence, scan_path,
   stats_json, packages_json, risky_json, logs_json)
select
  'psf', 'requests', '4ed3d1b3204caa6806a36125a39589044a02e807', 'main',
  o.id,
  98, 'Trusted', true, false,
  'The repository is a highly reputable, industry-standard Python library maintained by the Python Software Foundation. Static analysis identified hardcoded local loopback addresses (127.0.0.1) within test files, which are standard practice for verifying network adapter behavior in isolation. No malicious behavior was observed in our static read; full runtime behavior was not executed in a sandbox on this pass.',
  0.950, 'fast',
  '{"loc":"13555 KB","packages":0,"stars":"54070","created":"2599 days ago"}'::jsonb,
  '[]'::jsonb,
  '[
    {"title":"Hardcoded loopback address in tests","severity":"low","kind":"code","detail":"Test suite contains references to 127.0.0.1:10000 for local adapter verification; this is expected behavior for testing network libraries."},
    {"title":"High-reputation organization","severity":"low","kind":"rep","detail":"Maintained by the Python Software Foundation, a highly established and trusted entity."}
  ]'::jsonb,
  '[
    {"ch":"Clone","kind":"ok","lines":["Cloned repository psf/requests at commit 4ed3d1b3204caa6806a36125a39589044a02e807"]},
    {"ch":"Static scan","kind":"ok","lines":["Scanning 15 files for malicious patterns","No obfuscation or embedded secrets detected"]},
    {"ch":"Reputation","kind":"ok","lines":["Owner verified as Python Software Foundation","High star count and long account history confirmed"]},
    {"ch":"Read","kind":"warn","lines":["Identified hardcoded 127.0.0.1 addresses in tests/test_adapters.py","Verified these are used for local test assertions"]}
  ]'::jsonb
from public.owners o
where o.github_login = 'psf'
on conflict (owner_login, repo_name, commit_sha) do nothing;

-- chalk/chalk — score 98 "Trusted"
insert into public.reports
  (owner_login, repo_name, commit_sha, ref,
   owner_id, score, verdict, cached, deep, summary,
   confidence, scan_path,
   stats_json, packages_json, risky_json, logs_json)
select
  'chalk', 'chalk', 'aa06bb5ac3f14df9fda8cfb54274dfc165ddfdef', 'main',
  o.id,
  98, 'Trusted', true, false,
  'The repository is a highly established, widely used utility with no suspicious code patterns detected. While no malicious behavior was observed in our static read, full runtime behavior was not executed in a sandbox on this pass.',
  0.950, 'fast',
  '{"loc":"1067 KB","packages":0,"stars":"23262","created":"10 yr 12 mo"}'::jsonb,
  '[]'::jsonb,
  '[]'::jsonb,
  '[
    {"ch":"Clone","kind":"ok","lines":["Repository chalk/chalk cloned successfully.","Commit hash verified: aa06bb5ac3f14df9fda8cfb54274dfc165ddfdef."]},
    {"ch":"Static scan","kind":"ok","lines":["No suspicious patterns, obfuscation, or network calls detected in the 15 files scanned."]},
    {"ch":"Reputation","kind":"ok","lines":["Owner is an established organization with 10+ years of history.","High star count and community adoption indicate a trusted source."]},
    {"ch":"Read","kind":"ok","lines":["Code structure is clean and consistent with terminal styling utilities."]}
  ]'::jsonb
from public.owners o
where o.github_login = 'chalk'
on conflict (owner_login, repo_name, commit_sha) do nothing;

-- tj/commander.js — score 98 "Trusted"
insert into public.reports
  (owner_login, repo_name, commit_sha, ref,
   owner_id, score, verdict, cached, deep, summary,
   confidence, scan_path,
   stats_json, packages_json, risky_json, logs_json)
select
  'tj', 'commander.js', 'ba6d13ddb4243e5913367734f8c159089ffe7834', 'master',
  o.id,
  98, 'Trusted', true, false,
  'Commander.js is a widely used, highly established library for building CLI tools in Node.js. The static analysis of the codebase revealed no suspicious patterns, obfuscation, or unauthorized network activity. While this scan confirms the absence of malicious static indicators, it does not constitute a full runtime execution or sandbox analysis of the library''s behavior in a production environment.',
  0.950, 'fast',
  '{"loc":"3875 KB","packages":0,"stars":"28288","created":"17 yr 9 mo"}'::jsonb,
  '[]'::jsonb,
  '[]'::jsonb,
  '[
    {"ch":"Clone","kind":"ok","lines":["Cloned repository tj/commander.js at commit ba6d13d","Repository metadata verified"]},
    {"ch":"Static scan","kind":"ok","lines":["No flagged regions detected","No install hooks or obfuscated code found"]},
    {"ch":"Reputation","kind":"ok","lines":["Owner ''tj'' is highly established with 17+ years of history","High community trust and significant star count"]},
    {"ch":"Read","kind":"ok","lines":["Codebase structure is consistent with standard Node.js library practices","No malicious behavior observed in our static read; full runtime behavior was not executed in a sandbox on this pass"]}
  ]'::jsonb
from public.owners o
where o.github_login = 'tj'
on conflict (owner_login, repo_name, commit_sha) do nothing;

-- gorilla/mux — score 95 "Trusted"
insert into public.reports
  (owner_login, repo_name, commit_sha, ref,
   owner_id, score, verdict, cached, deep, summary,
   confidence, scan_path,
   stats_json, packages_json, risky_json, logs_json)
select
  'gorilla', 'mux', 'db9d1d0073d27a0a2d9a8c1bc52aa0af4374d265', 'main',
  o.id,
  95, 'Trusted', true, false,
  'gorilla/mux is a widely recognized, long-standing Go routing library. The static analysis identified hardcoded IP/port combinations in documentation and examples, which are standard for demonstrating server setup and do not represent malicious behavior. No malicious behavior was observed in our static read; full runtime behavior was not executed in a sandbox on this pass.',
  0.950, 'fast',
  '{"loc":"543 KB","packages":1,"stars":"21839","created":"15 yr 7 mo"}'::jsonb,
  '[
    {"name":"gorilla/mux","score":95,"note":"Standard HTTP router for Go; highly established and widely used."}
  ]'::jsonb,
  '[
    {"title":"Hardcoded IP/Port in documentation","severity":"low","kind":"code","detail":"Examples in README.md and doc.go contain hardcoded local addresses (127.0.0.1:8000, 0.0.0.0:8080) for demonstration purposes."},
    {"title":"Established Organization","severity":"low","kind":"rep","detail":"The repository is maintained by the Gorilla web toolkit organization, which has a 15-year history and high community trust."}
  ]'::jsonb,
  '[
    {"ch":"Clone","kind":"ok","lines":["Cloned repository gorilla/mux at commit db9d1d0073d27a0a2d9a8c1bc52aa0af4374d265"]},
    {"ch":"Static scan","kind":"ok","lines":["Scanned 15 files for malicious patterns.","No obfuscation, credential access, or install-time network activity detected."]},
    {"ch":"Reputation","kind":"ok","lines":["Owner ''gorilla'' is a well-established organization with 15+ years of history.","High star count (21839) indicates significant community adoption."]},
    {"ch":"Read","kind":"warn","lines":["Identified hardcoded IP/port snippets in documentation files (README.md, doc.go).","Confirmed these are standard example configurations for local server binding."]}
  ]'::jsonb
from public.owners o
where o.github_login = 'gorilla'
on conflict (owner_login, repo_name, commit_sha) do nothing;

-- ---------------------------------------------------------------------------
-- scans — real-repo scan events so v_activity and dashboard history are
-- non-empty. Service-role context; no user_id (public activity feed rows).
-- Timestamps spread over the last few minutes to mimic a live ticker.
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
  false,
  now() - (ev.offset_secs || ' seconds')::interval
from (values
  (1, 'expressjs', 'express',      'fast', 98,   0),
  (2, 'pallets',   'flask',        'fast', 98,  18),
  (3, 'psf',       'requests',     'fast', 98,  44),
  (4, 'gorilla',   'mux',          'fast', 95,  60),
  (5, 'chalk',     'chalk',        'fast', 98, 120),
  (6, 'tj',        'commander.js', 'fast', 98, 180)
) as ev(ord, owner_login, repo_name, scan_path, score, offset_secs)
join public.reports r
  on r.owner_login = ev.owner_login
 and r.repo_name   = ev.repo_name
on conflict do nothing;

commit;
