# ClaudeRabbit 2.0: 1.0 backfill report (2026-10-22)

Every target 1.0 scanned (39 rows in the 1.0 reports table, read only: 28 GitHub repos and 4 npm packages) was
scanned again on the 2.0 preview, 5 at a time: each target's current version, plus the exact commit or version 1.0
scanned when it differs. 71 scan requests per pass. Pass 1 ran on score rules 27; it exposed the bugs below. Pass 2
ran all 71 again after the fixes. The tables use the newest 2.0 scan of each target and commit.

Totals (newest scan per target and commit): `TOTALS scans=63 failed=0 partial=3 inr=8.959 median_s=31.2 max_s=138.1`

## Bugs the backfill exposed, and their fixes (general rules)

1. **Repos with no install step were "Partial scan", Caution 74.** Go, Kotlin and binary-only repos (no package.json,
   pyproject.toml, setup.py or requirements.txt: HackBrowserData, PixelPlayer, codexffmpeg, ncurses-snapshots,
   JARVIS, flow-agent) were marked partial and capped at 74 with "Install did not complete". Nothing was cut; there
   is no install step. Fix (`80e17fa`, score rules 28): install outcome "none", not partial, capped at Low risk 80
   because nothing ran, and "not verified" says the code was read, not run.
2. **Scans failed with "GitHub API rate limit reached".** The preview calls the GitHub REST API without a token, a
   few dozen calls an hour per IP; 6 of pass 1's scans failed. Fix (`673278e`, `a48b9de`): resolution falls back to
   git's upload-pack ref advertisement on github.com, which that limit does not cover (HEAD and its default branch,
   branches, peeled tags, or a full SHA as given); stars and other API metadata are left unknown on that path.
3. **supabase at its July commit scored High risk 25.** It depends on a JSR package; the forge did not know JSR's
   npm-compatible registry (npm.jsr.io), forged the tarball, the install failed, and the run was scored for
   contacting a non-registry host. Fix (`8110049`, rules 29): npm.jsr.io is an npm registry in the forge policy, the
   egress allow list and the capture, with JSR's tarball path shape.
4. **npm:Hello failed with no forensic record.** The harness's package-name check allowed lowercase only; older npm
   names have capitals. Fix (`8110049`): capitals allowed.
5. **The danger board listed every report row, with our test fixtures at the top, and the newest row per target.**
   Fixes: `7be4f82` (one row per target; repos named `cr-…fixture` off the board and the sitemap), `9e09eaa` (a scan of
   a target's current version is marked ref 'latest' and the board prefers it, so an older commit scanned later by the
   backfill no longer replaces the current one).

## Every scan

| target | commit | 1.0 | 2.0 | time | cost |
|---|---|---|---|---|---|
| abi/screenshot-to-code | `d026163f586d` (1.0 commit) | 88 Likely safe | 90 No threats observed | 41.6 s | ₹0.109 |
| abi/screenshot-to-code | `a8139779f7c5` (latest) | 88 Likely safe | 90 No threats observed | 47.1 s | ₹0.120 |
| AgriciDaniel/claude-seo | `e77e783e38ee` (1.0 commit) | 88 Likely safe | 90 No threats observed | 37.7 s | ₹0.099 |
| AgriciDaniel/claude-seo | `23a2a811f874` (latest) | 88 Likely safe | 90 No threats observed | 41.3 s | ₹0.107 |
| AIdhirajSingh/clauderabbit | `f64224004151` (1.0 commit) | 59 High risk | 90 No threats observed | 101.2 s | ₹0.240 |
| AIdhirajSingh/clauderabbit | `240d6b3eb22f` (latest) | 59 High risk | 90 No threats observed | 92.5 s | ₹0.217 |
| AIdhirajSingh/cr-exfil-test-fixture | `ff139fd664ed` (1.0 commit) | 0 Malicious | 0 Malicious | 20.9 s | ₹0.078 |
| AmrDab/clawdcursor | `916ec8427fe6` (1.0 commit) | 33 High risk | 80 Low risk | 40.4 s | ₹0.153 |
| AmrDab/clawdcursor | `35800c629a92` (1.0 commit) | 64 Caution | 80 Low risk | 45.2 s | ₹0.165 |
| AmrDab/clawdcursor | `6702020eb1e1` (1.0 commit) | 64 Caution | 80 Low risk | 44.9 s | ₹0.162 |
| AmrDab/clawdcursor | `ef5d8ba30a79` (latest) | 64 Caution | 80 Low risk | 47.1 s | ₹0.169 |
| chalk/chalk | `aa06bb5ac3f1` (1.0 commit) | 100 Trusted | 90 No threats observed | 27.4 s | ₹0.079 |
| chalk/chalk | `47fc05abd461` (latest) | 100 Trusted | 90 No threats observed | 31.9 s | ₹0.088 |
| expressjs/express | `0dee2c52c7c8` (1.0 commit) | 100 Trusted | 90 No threats observed | 34.0 s | ₹0.095 |
| expressjs/express | `7ef98448f8b3` (1.0 commit) | 100 Trusted | 90 No threats observed | 26.9 s | ₹0.079 |
| GabrielGargiuloDev/google-flow-mcp | `aae58a79aecd` (1.0 commit) | 79 Caution | 90 No threats observed | 30.7 s | ₹0.084 |
| GyanD/codexffmpeg | `46465995c991` (1.0 commit) | 100 Trusted | 80 Low risk | 17.8 s | ₹0.055 |
| GyanD/codexffmpeg | `e90aadc8ca46` (latest) | 100 Trusted | 80 Low risk | 22.0 s | ₹0.061 |
| i-voted-for-trump/is-odd | `a80ee0d831a8` (1.0 commit) | 89 Likely safe | 90 No threats observed | 21.0 s | ₹0.062 |
| jonschlinkert/is-number | `98e8ff1da1a8` (1.0 commit) | 97 Trusted | 90 No threats observed | 20.8 s | ₹0.066 |
| kodelyx/flow-agent | `e7f64ae00e3e` (1.0 commit) | 82 Likely safe | 80 Low risk | 24.6 s | ₹0.078 |
| kodelyx/flow-agent | `7d7abdd4da1a` (latest) | 82 Likely safe | 80 Low risk | 26.1 s | ₹0.100 |
| microsoft/JARVIS | `7624cf388b47` (1.0 commit) | 97 Trusted | 80 Low risk | 25.1 s | ₹0.097 |
| moonD4rk/HackBrowserData | `6502d5ee14a4` (1.0 commit) | 97 Trusted | 80 Low risk | 26.8 s | ₹0.075 |
| moonD4rk/HackBrowserData | `95c47885d3dc` (latest) | 97 Trusted | 80 Low risk | 20.8 s | ₹0.062 |
| NandhaKishorM/laya | `2e4d9c87e8b1` (1.0 commit) | 97 Trusted | 90 No threats observed (Partial scan) | 106.3 s | ₹0.257 |
| NandhaKishorM/laya | `6f0496f797dc` (latest) | 97 Trusted | 85 Low risk (Partial scan) | 124.5 s | ₹0.296 |
| npm:bufferutil | `4.1.0+sha512` (1.0 commit) | 37 High risk | 74 Caution | 24.0 s | ₹0.098 |
| npm:Hello | `0.0.1+sha512` (1.0 commit) | 82 Likely safe | 90 No threats observed | 20.3 s | ₹0.041 |
| npm:left-pad | `1.3.0+sha512` (1.0 commit) | 90 Trusted | 90 No threats observed | 20.4 s | ₹0.073 |
| npm:nanoid | `6.0.1+sha512` (1.0 commit) | 94 Trusted | 90 No threats observed | 12.8 s | ₹0.054 |
| npm:nanoid | `6.0.2+sha512` (latest) | 94 Trusted | 90 No threats observed | 14.1 s | ₹0.058 |
| open-jarvis/OpenJarvis | `57eea1d5b958` (1.0 commit) | 92 Trusted | 60 Caution | 48.4 s | ₹0.227 |
| open-jarvis/OpenJarvis | `8f81c024608b` (latest) | 92 Trusted | 60 Caution (Partial scan) | 49.8 s | ₹0.228 |
| openclaw/openclaw | `236d1b2484ca` (1.0 commit) | 92 Trusted | 80 Low risk | 98.6 s | ₹0.410 |
| openclaw/openclaw | `d731b3fef073` (latest) | 92 Trusted | 80 Low risk | 72.5 s | ₹0.317 |
| openclaw/openclaw | `f81518e88e21` (latest) | 92 Trusted | 80 Low risk | 74.6 s | ₹0.307 |
| openclaw/openclaw | `d08aeb1d984a` (latest) | 92 Trusted | 80 Low risk | 75.1 s | ₹0.319 |
| PixelPlayerHQ/PixelPlayer | `8b91d99c54fa` (1.0 commit) | 64 Caution | 80 Low risk | 31.2 s | ₹0.083 |
| PixelPlayerHQ/PixelPlayer | `63cb59b97aff` (latest) | 64 Caution | 80 Low risk | 29.2 s | ₹0.082 |
| sindresorhus/is | `e9c026c611c1` (1.0 commit) | 100 Trusted | 90 No threats observed | 29.1 s | ₹0.097 |
| sindresorhus/is | `7821031c66cd` (1.0 commit) | 100 Trusted | 90 No threats observed | 29.7 s | ₹0.102 |
| sindresorhus/is | `a4393055546c` (1.0 commit) | 100 Trusted | 90 No threats observed | 31.2 s | ₹0.102 |
| sindresorhus/is | `2d4956e63491` (1.0 commit) | 100 Trusted | 90 No threats observed | 28.1 s | ₹0.096 |
| sindresorhus/is | `48df5c429ced` (1.0 commit) | 100 Trusted | 90 No threats observed | 29.9 s | ₹0.100 |
| sindresorhus/p-limit | `783068bb9e96` (1.0 commit) | 100 Trusted | 90 No threats observed | 28.8 s | ₹0.079 |
| sindresorhus/p-limit | `a8a6fbec4e0e` (latest) | 100 Trusted | 90 No threats observed | 36.3 s | ₹0.097 |
| sindresorhus/p-map | `bc8380d30979` (1.0 commit) | 100 Trusted | 90 No threats observed | 34.8 s | ₹0.095 |
| sindresorhus/p-map | `d61b6a33cc1d` (latest) | 100 Trusted | 90 No threats observed | 34.9 s | ₹0.095 |
| sindresorhus/p-queue | `180ab9e25cd1` (1.0 commit) | 100 Trusted | 90 No threats observed | 36.9 s | ₹0.099 |
| sindresorhus/p-queue | `7f272ab5ff22` (latest) | 100 Trusted | 90 No threats observed | 30.4 s | ₹0.083 |
| sindresorhus/p-retry | `81cd2f0e523f` (1.0 commit) | 100 Trusted | 90 No threats observed | 32.1 s | ₹0.088 |
| sindresorhus/p-retry | `1472907affe8` (latest) | 100 Trusted | 90 No threats observed | 33.1 s | ₹0.089 |
| supabase/supabase | `c1d010a699a7` (1.0 commit) | 89 Likely safe | 80 Low risk | 138.1 s | ₹0.532 |
| supabase/supabase | `bbf0e730f2fe` (latest) | 89 Likely safe | 80 Low risk | 125.2 s | ₹0.496 |
| supabase/supabase | `dd09501bac34` (latest) | 89 Likely safe | 80 Low risk | 137.3 s | ₹0.530 |
| ThomasDickey/ncurses-snapshots | `dec1069c5d89` (1.0 commit) | 97 Trusted | 80 Low risk | 21.7 s | ₹0.060 |
| ThomasDickey/ncurses-snapshots | `983f8e3bc8ce` (latest) | 97 Trusted | 80 Low risk | 18.2 s | ₹0.053 |
| TMSSS05/google-flow-browser-mcp | `0c8e80ae4acb` (1.0 commit) | 85 Likely safe | 90 No threats observed | 28.9 s | ₹0.081 |
| usestrix/strix | `84f4108195fb` (1.0 commit) | 88 Likely safe | 80 Low risk | 44.5 s | ₹0.151 |
| usestrix/strix | `0f81f40765f0` (latest) | 88 Likely safe | 80 Low risk | 43.1 s | ₹0.151 |
| wolfi-dev/wolfictl | `53a57e8dcd72` (1.0 commit) | 94 Trusted | 80 Low risk | 23.3 s | ₹0.063 |
| wolfi-dev/wolfictl | `e41d45183bc4` (latest) | 94 Trusted | 80 Low risk | 25.3 s | ₹0.067 |

| target | commit | flag | cause |
|---|---|---|---|
| AIdhirajSingh/clauderabbit | `240d6b3eb22f` | gap 31 | 1.0 scored 59 from reading the code; 2.0 ran the install and entry in the sandbox and saw no bad behaviour and no flagged code that runs |
| AIdhirajSingh/clauderabbit | `f64224004151` | gap 31 | 1.0 scored 59 from reading the code; 2.0 ran the install and entry in the sandbox and saw no bad behaviour and no flagged code that runs |
| AmrDab/clawdcursor | `916ec8427fe6` | gap 47 | the repo's own lifecycle script failed after its dependencies installed; deductions: -10 2 reachable finding location(s). |
| NandhaKishorM/laya | `6f0496f797dc` | 124 s, Partial scan | install hit its time limit; deductions: -5 1 reachable finding location(s).; time: archive fetch 6 s, sandbox install 76 s, code checks 80 s (in parallel) |
| NandhaKishorM/laya | `2e4d9c87e8b1` | Partial scan | install hit its time limit |
| npm:bufferutil | `4.1.0+sha512` | gap 37 | deductions: -13 Part of the sandbox forensic record was cut, so the score is capped at 74. |
| open-jarvis/OpenJarvis | `8f81c024608b` | gap 32, Partial scan | entry point cut by its time limit; a forensic record was cut at its size cap; deductions: -40 23 reachable finding location(s), -185 floored at -40. |
| open-jarvis/OpenJarvis | `57eea1d5b958` | gap 32 | deductions: -40 23 reachable finding location(s), -178 floored at -40. |
| supabase/supabase | `bbf0e730f2fe` | 125 s | deductions: -40 9 reachable finding location(s), -52 floored at -40.; time: archive fetch 37 s, sandbox install 45 s, code checks 63 s (in parallel) |
| supabase/supabase | `c1d010a699a7` | 138 s | deductions: -40 9 reachable finding location(s), -52 floored at -40.; time: archive fetch 34 s, sandbox install 61 s, code checks 78 s (in parallel) |
| supabase/supabase | `dd09501bac34` | 137 s | deductions: -40 9 reachable finding location(s), -52 floored at -40.; time: archive fetch 31 s, sandbox install 61 s, code checks 79 s (in parallel) |

## Danger board, top 10 (v2 database, after the fixes)

 1. open-jarvis/OpenJarvis — 60 Caution
 2. react/react — 60 Caution
 3. npm/bufferutil — 74 Caution
 4. lodash/lodash — 74 Caution
 5. openclaw/openclaw — 80 Low risk
 6. wolfi-dev/wolfictl — 80 Low risk
 7. supabase/supabase — 80 Low risk
 8. usestrix/strix — 80 Low risk
 9. microsoft/JARVIS — 80 Low risk
10. AmrDab/clawdcursor — 80 Low risk
