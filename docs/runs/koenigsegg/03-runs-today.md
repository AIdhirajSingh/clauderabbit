## Step 3: Runs today (2026-10-16), one real scan per surface

Target: `jonschlinkert/is-odd` at `a80ee0d831a8ee69f1fad5b4673491847975eb26` (pinned in 02-cost-per-scan.md). Production domain: `clauderabbit.in`, measured from the repo docs:

```
$ grep -rhoE "https://[a-z0-9.-]*clauderabbit[a-z0-9.-]*" README.md CLAUDE.md | sort | uniq -c
   6 https://clauderabbit.in
```

### Scoreboard

| Surface | Command / tool | Exit | Wall time | Verdict / score | Bare "Safe"? | Result |
|---|---|---|---|---|---|---|
| Web (owner as typed) | Browser `navigate https://clauderabbit.in/jonschlinkert/is-odd` + `get_page_text` | page loaded | UNKNOWN (browser tool reports no timing) | "This repository has not been scanned yet." | n/a | FAIL |
| Web (owner the report is stored under) | Browser `navigate https://clauderabbit.in/i-voted-for-trump/is-odd` + `get_page_text` | page loaded | UNKNOWN (browser tool reports no timing) | 89 / 100, "Likely safe", "Static read" | No | PASS |
| CLI | `npx -y clauderabbit@0.1.8 version` | 0 | 4s for the first npx fetch (measured on `--version`) | `0.1.8` | n/a | PASS |
| CLI | `npx -y clauderabbit@0.1.8 scan https://github.com/jonschlinkert/is-odd` | 144 (killed) | over 78s, blocked on browser sign-in, killed manually | no verdict: "Not signed in" | n/a | FAIL (auth-gated, no unattended path) |
| Remote MCP (connected tool) | `mcp__546d4fec-...__scan {owner: jonschlinkert, repo: is-odd}` | success | UNKNOWN (tool reports no timing) | 89 / 100, "Likely safe", `fresh:false` (cache hit) | No | PASS with defect (see 3.3) |
| Remote MCP (raw HTTP) | `curl -X POST https://clauderabbit.in/mcp` initialize + tools/list, no token | HTTP 401 | 1.33s / 0.35s | `{"error":"unauthorized"}` | n/a | PASS (auth enforced); tool list UNKNOWN unauthenticated |

### 3.1 Web

Canonical path a user types:

```
navigate https://clauderabbit.in/jonschlinkert/is-odd
get_page_text ->
Title: jonschlinkert/is-odd — ClaudeRabbit safety report
jonschlinkert/is-odd
This repository has not been scanned yet. Run a free safety scan to generate its public report ...
Scan jonschlinkert/is-odd
```

The report for the same commit exists under the GitHub-redirected owner:

```
navigate https://clauderabbit.in/i-voted-for-trump/is-odd
get_page_text ->
89
OUT OF 100
Likely safe
Likely safe
Static read
i-voted-for-trump/is-odd
...
Commit hash: a80ee0d831a8ee69f1fad5b4673491847975eb26
...
Score computed by formula: 89/100 (deterministic, code-driven)
+3 [reputation] some_stars: Some community signal (361 stars).
+4 [reputation] good_sentiment: Positive community sentiment (90/100).
Auto-published at clauderabbit.in/i-voted-for-trump/is-odd · re-checked when the repo changes
```

Verdict text is "Likely safe" with "Static read" and a "What we could not verify" list. No bare "Safe". I did not click "Scan jonschlinkert/is-odd" (a form submit that triggers a production scan); the cached report covers this step's verdict check.

Defect W1: the page at the owner the user requested (`jonschlinkert`) says "not scanned yet" while a report for the identical commit exists under the redirect target owner (`i-voted-for-trump`). A user following the MCP tool's own `reportUrl` lands on the "not scanned" page (see 3.3).

### 3.2 CLI

```
$ npx -y clauderabbit@0.1.8 --version
clauderabbit — scan a public GitHub repo or npm package for a 0-100 safety
score before you install or clone it. Requires a signed-in ClaudeRabbit account
...
  help | version
EXIT=0 WALL=4s

$ npx -y clauderabbit@0.1.8 version
0.1.8
EXIT=0

$ ls ~/.clauderabbit/
ls: /Users/adhirajsingh/.clauderabbit/: No such file or directory

$ BROWSER=echo perl -e 'alarm 25; exec @ARGV' npx -y clauderabbit@0.1.8 scan https://github.com/jonschlinkert/is-odd </dev/null
Not signed in — starting sign-in…
Opening your browser to sign in:
  https://clauderabbit.in/cli-auth?port=61770
[exited with code 144]   (process 51369 still alive at etime 01:18, killed with kill)
```

Findings:
- C1: `--version` is not a recognized flag; it prints the full help text. Only the bare `version` subcommand prints `0.1.8`.
- C2: `scan` with no credentials blocks indefinitely waiting on a localhost browser callback. With stdin closed and no TTY it does not fail fast; the node child outlived a 25s SIGALRM on its npx parent and ran past 78s until killed. No CI/headless path exists without a pre-issued `login --token`.
- No credentials were entered. Verdict via CLI: UNKNOWN.

### 3.3 Remote MCP

Connected tool call:

```
mcp__546d4fec-8493-4095-bbbb-7bd0fe1c43b8__scan {"owner":"jonschlinkert","repo":"is-odd"} ->
{"owner":"i-voted-for-trump","repo":"is-odd","score":89,"verdict":"Likely safe",
 "reportUrl":"https://clauderabbit.in/jonschlinkert/is-odd","fresh":false,
 "escalationDecided":false,"sandboxActuallyRan":false,
 "commitSha":"a80ee0d831a8ee69f1fad5b4673491847975eb26","codeBehaviorFindings":[], ...
 "notVerified":["Full runtime behavior (this repo was not executed in a sandbox on this pass)", ...]}
```

Score 89 and verdict "Likely safe" match the web report for the same commit. `sandboxActuallyRan:false` with `escalationDecided:false` is consistent. No bare "Safe".

Defect M1: `reportUrl` is `https://clauderabbit.in/jonschlinkert/is-odd`, which renders "This repository has not been scanned yet" (3.1). The response's own `owner` field is `i-voted-for-trump`, where the report actually renders. The link the MCP hands an agent is dead for transferred/renamed repos.

Raw endpoint:

```
$ curl -sS -m 20 -X POST https://clauderabbit.in/mcp -H 'content-type: application/json' \
   -H 'accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"initialize",...}'
{"error":"unauthorized"}
HTTP=401 TIME=1.330644s

$ curl ... -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
{"error":"unauthorized"}
HTTP=401 TIME=0.351966s
```

The endpoint rejects unauthenticated `initialize` and `tools/list` with HTTP 401. The 401 body is plain JSON, not a JSON-RPC error object, and carries no `WWW-Authenticate` excerpt in this capture (headers were not dumped). Unauthenticated tool list: UNKNOWN.

### UNKNOWNs

- Web page wall time (browser tool exposes no timing).
- MCP connected-tool wall time (tool exposes no timing).
- CLI scan verdict and wall time (blocked on sign-in; no credentials entered by rule).
- `/mcp` tools/list contents without a token (HTTP 401).
- Fresh-scan path on any surface: every verdict today is a cache hit (`fresh:false`); no new scan was submitted.
