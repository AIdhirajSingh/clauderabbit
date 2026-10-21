# 2.0 UI data map

Every field the Prototype 3 screens draw, and the backend record it comes from. The UI never
writes a value of its own: where a field has no backend source, it is listed under "Gaps" and the
UI leaves it out instead of inventing it.

Sources: `ReportPayload` (`lib/engine/types.ts`, rebuilt from `v2.reports` + `v2.scan_runs` by
`payloadFromRows` in `lib/engine/store.ts`), `ScanEvent` rows in `v2.scan_events`, and the run row
in `v2.scan_runs`.

## Danger board (`/app`, `GET /api/board`)

| Design field | Source | Notes |
|---|---|---|
| score tile | `v2.reports.score` | |
| name | `owner_login/repo_name`; npm rows are stored as owner `npm`, so the name is `repo_name` | `lib/cr/verdict.ts displayName` |
| GitHub / npm icon | `owner_login = 'npm'` | |
| verdict pill | `v2.reports.verdict` (engine `verdictFor`) | word + glyph + tone; never "Safe" |
| one-line finding | top code/behaviour deduction in `score_breakdown` (most negative `points`, reputation group excluded), else "Nothing taken off" | `topFinding` |
| when | `v2.reports.created_at` | relative time |
| order | `score asc, created_at desc` | tarball (operator) rows excluded |
| filters | All, Malicious, High risk, Caution, Low risk; Low risk also covers the engine's "No threats observed" | `FILTER_VERDICTS` |
| live updates | Realtime Broadcast topic `board`, event `report`, from a trigger on `v2.reports` (migration `20261021000001`) | the board reloads what is on screen |
| row link | `v2.reports.run_id` → `/app/scan/<run_id>` | |

## Scan page while running (`/app/scan/<id>`)

| Design field | Source |
|---|---|
| repo name | `v2.scan_runs.subject` (`npm:` prefix dropped) |
| commit | `v2.scan_runs.commit_sha` (7 chars for a git SHA, the version for npm) |
| stage | latest `stage` event with `status: start`, worded per `StageName` |
| timer | live: now − `scan_runs.started_at`; replay: `t_ms` of the last shown event |
| progress bars (Fetching, Installing, Running, Checking, Scoring) | `stage` events bucketed: cache/resolve/fetch/verify → 1, reach/osv → 2, detonate → 3, static/checks → 4, score/report/persist → 5 |
| event log | `stage` (detail), `forged_call` (host, path: "answered by the forge"), `file`, `process` (argv), `check` events; `timing` and `transcript` are not shown |
| five checks | Malware database ← `osv` done; Install scripts, Network calls, Files outside the project ← `detonate` done; Code checks ← `static` and `checks` done |
| stream | the POST `/api/scan` NDJSON stream (kept across the client-side move to the scan page); on reload or a dropped stream, `GET /api/runs/<id>/events` + Realtime `scan:<id>`, deduplicated by `seq`, plus a 2.5 s poll of the run status |

## Result

| Design field | Source |
|---|---|
| score | `ReportPayload.score` |
| verdict | `ReportPayload.verdict` (word, glyph, tone) |
| "Scanned … · N s" | `scan_runs.finished_at` (relative) · `timings.total_ms`, else `finished_at − started_at` |
| Report card (two paragraphs) | `ReportPayload.luna_report.what_ran` and `.what_matters` (new, Luna's structured output); reports written before it show `summary` as one paragraph |
| Points taken off | `breakdown[]` with `points < 0`, reputation group excluded: `points`, `detail` (title), `evidence[]` (refs) |
| What it ran | `evidence.behaviour[]` lines |
| Not verified | `not_verified[]` |
| Reputation, "shown separately" | `reputation_section.facts[]` (`fact`, with `source` as the tooltip) and `.warnings[]`; never part of the score |
| Share | `/app/scan/<run_id>` |
| Watch how it happened | `/app/scan/<run_id>?replay=1` replays `v2.scan_events` at 4× |

## Account card

| Design field | Source |
|---|---|
| name, email, avatar | Supabase Auth session (`user_metadata.full_name`, `email`, `avatar_url`) |
| scan count and list | `GET /api/me/scans` → `v2.user_scans` joined to `v2.scan_runs` and `v2.reports` |

Guests: `user_scans` gets no row and `scan_runs.user_id` stays null. Nothing about a guest is stored.

## Gaps (backend has no field yet; the UI does not invent one)

- **What it ran as key/value rows** (package manager with installed and skipped counts, install
  time, install-script count, network summary, entry point and exit code). The design draws four
  labelled rows; the engine has the raw facts inside `forensics` and `packages` but no stable,
  typed summary. Until the engine adds `ran: { package_manager, installed, skipped, install_ms,
  install_scripts, network, entry_point }` to `ReportPayload`, the UI lists `evidence.behaviour`.
- **Verdict thresholds.** The design says Low risk 80–100, Caution 50–79, High risk 20–49,
  Malicious 0–19. The engine (`verdictFor`) uses No threats observed ≥ 90, Low risk ≥ 80,
  Caution ≥ 60, High risk ≥ 30, Malicious < 30. The UI shows the engine's word; changing the
  thresholds is a scoring-rules change, not a UI one.
