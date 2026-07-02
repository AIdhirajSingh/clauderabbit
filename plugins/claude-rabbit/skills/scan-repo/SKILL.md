---
name: scan-repo
description: Scan a public GitHub repo, fork, or npm/pip package for safety with Claude Rabbit before installing, cloning, or depending on it. Use when the user pastes a GitHub URL or package name and asks "is this safe", "scan this repo", "check this before I install it", "is this package trustworthy", or similar — or any time you (the agent) are about to recommend the user add an unfamiliar third-party dependency and want to check it first.
---

# Claude Rabbit: scan-repo

Claude Rabbit reads a repo's code, checks the owner/package's reputation, and — when the fast checks are ambiguous — runs the code in a hermetic, single-use sandbox to observe what it actually does. It returns a single 0-100 safety score plus an honest, plain-language report. It never states a bare "Safe".

## When to use this skill

Invoke this skill when:
- The user pastes a GitHub URL, `owner/repo` shorthand, or a package name (npm, pip, etc.) and asks whether it is safe to use, install, or depend on.
- You are about to suggest adding a new third-party dependency to the user's project and want to check it first.
- The user explicitly asks to "scan", "check", or "audit" a repo/package with Claude Rabbit.

Do not invoke this skill for the user's own first-party code, or for well-known, already-vetted standard-library-equivalent packages the user is clearly already using — reserve it for genuinely unfamiliar third-party code.

## How to run the scan

This skill shells out to the `claude-rabbit` CLI. Run:

```bash
claude-rabbit scan <target> --json
```

Where `<target>` is the GitHub URL, `owner/repo` shorthand, or package spec the user gave you.

**If the `claude-rabbit` binary is not found on PATH**, tell the user plainly: this skill depends on the `claude-rabbit-cli` package (see the plugin's README for status), it is not installed, and you cannot run a live scan right now. Do not fabricate a result. Offer to read the code manually instead as a fallback, and be clear that a manual read is not equivalent to Claude Rabbit's sandboxed dynamic scan.

If the CLI is present, parse the JSON it prints to stdout. Expect fields roughly shaped like:

```json
{
  "target": "owner/repo",
  "score": 0,
  "verdict": "string",
  "reputation": { "...": "owner/account signals" },
  "behavior": { "...": "static + dynamic findings" },
  "notVerified": ["..."],
  "reportUrl": "https://..."
}
```

Treat this shape as indicative, not guaranteed — inspect the actual JSON returned and adapt. If the CLI errors or returns malformed JSON, surface the raw stderr/stdout to the user rather than inventing a score.

## How to render the report inline — rules that are not optional

These rules come directly from Claude Rabbit's product constitution and apply just as much in this terminal/agent context as they do on the web report. Follow them exactly:

1. **Never state a bare "Safe."** Do not render a verdict as just "Safe" or "This is safe to use." Always show the evidence behind the score and state plainly what was *not* verified — for example: "No malicious behavior observed in our sandbox run; the owner account is 3 weeks old and has no other public repos." A confident wrong "Safe" is the one outcome this tool exists to prevent.
2. **Keep reputation and behavior signals visibly separate.** Owner history, account age, stars, and sentiment are one category. What the code does and what running it revealed are a different category. Present them as two distinct sections or clearly labeled groups — never blend them into one undifferentiated bullet list.
3. **Always show the score with its color-tier meaning**, not just a number: green (high/secure), blue (upper-middle), yellow (warning), red (low/dangerous). In a terminal, spell the tier out in words (e.g. "78/100 — upper-middle / blue tier") since color may not render.
4. **State what was and was not run.** If the scan resolved on the fast path (static + reputation only, no dynamic sandbox), say so — do not imply a dynamic run happened if it did not.
5. **Link to the full public report** (`reportUrl` in the JSON, if present) so the user can see the complete evidence trail, share it, or embed the trust badge.

## Example inline rendering

```
Claude Rabbit scan: acme/sketchy-cli-tool

Score: 34/100 — red tier (low / dangerous)
Scan depth: fast path only (static analysis + reputation; sandbox not triggered)

Reputation signals
- Owner account created 11 days ago
- No other public repositories
- 2 stars, no external contributors

Code/behavior signals
- Static scan flagged an obfuscated postinstall script
- Dynamic sandbox NOT run for this scan (fast path resolved with high enough confidence to skip escalation)

Not verified
- Runtime network behavior was not observed (no sandbox run)
- No manual human code review was performed

Full report: https://clauderabbit.dev/acme/sketchy-cli-tool
```

Notice the example never says "safe" or "dangerous" as a bare word without the surrounding evidence — it states tier + evidence + what's unverified, every time.
