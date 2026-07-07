# Contributing to ClaudeRabbit

Thanks for helping build a public good. ClaudeRabbit is a free, open-source security product for
the developer community, and it improves fastest with more eyes on the code and more real repos
run through the sandbox.

This guide covers how to get it running locally and what we look for in a pull request.

## Before you start — the two rails that never bend

ClaudeRabbit is a security product, so the bar is higher, not lower. Two rules override everything
else, and a change that breaks either will not be merged:

1. **Never a bare "Safe."** No screen, report, score, or API response ever declares a flat "Safe."
   Every verdict shows its evidence and states plainly what was *not* verified.
2. **The sandbox is hermetic and reset every scan.** No real credentials, locked-down egress,
   capped resources, reimaged after every single scan. Anything touching `sandbox/` is the most
   safety-critical code in the project and gets the most care.

Two more structural rules: **secrets stay server-side** (only the Supabase URL + publishable key are
ever client-side — never commit `.env*` or `*-key.json`), and **reputation signals stay separate
from code/behavior signals** everywhere a verdict is explained.

The UI is a faithful port of the shipped Claude Design spec (`design.md`) — please preserve it
exactly rather than redesigning. Minimal, faithful adaptations to fit Next.js are fine.

## Prerequisites

- **Node.js 24** (LTS) and npm.
- Optional, only if you're working on those layers:
  - **Supabase CLI** — for the database and edge functions.
  - **Deno** — for the edge-function unit tests.

You do **not** need any cloud credentials or a Supabase project to work on most of the web layer —
the client only needs the two public env values below.

## Local setup

```bash
git clone https://github.com/AIdhirajSingh/clauderabbit.git
cd clauderabbit
npm install
cp .env.example .env.local     # fill in the Supabase URL + publishable key (both public values)
npm run dev                    # http://localhost:2311
```

The `cli/` and `mcp-server/` packages are self-contained — each has its own `package.json` and is
built independently (`cd cli && npm install && npm run build`). See the
[repo layout](README.md#repo-layout) for what lives where.

## Running the checks

Before opening a PR, these must all pass:

```bash
npm run lint          # eslint
npm run typecheck     # tsc --noEmit
npm run build         # next build
npm test              # app/lib/component unit tests
npm run test:functions   # Deno edge-function tests (needs Deno) — scoring + static-scan
```

The same set (plus a gitleaks secret-scan) is defined as a CI workflow in
`.github/workflows/ci.yml.disabled`.

## Opening a pull request

- **Branch** off `main` and keep PRs small and focused — one logical change per PR.
- **Verify by running**, not just by reading. "It renders" is not "it works." Tell us in the PR
  description what you actually ran and observed.
- **Keep the checks green** — lint, typecheck, and build must pass.
- **Never commit secrets** — no `.env*`, no service-account JSON. `.gitignore` covers the common
  cases; double-check anything new.
- **Don't weaken the rails** — no bare "Safe", no change that erodes sandbox isolation, no blending
  of reputation and behavior signals.
- **Preserve the design** — don't redesign UI that's ported from `design.md`.
- Write a clear commit message that says *what* changed and *why*.

## What to work on

- Issues labelled [`good first issue`](https://github.com/AIdhirajSingh/clauderabbit/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22)
  are scoped for newcomers.
- Ideas, questions, and "is this repo safe?" conversations belong in
  [GitHub Discussions](https://github.com/AIdhirajSingh/clauderabbit/discussions).

## Reporting a vulnerability

Please **do not** open a public issue for a security vulnerability — especially anything touching the
sandbox isolation, egress containment, or secret handling. Report it privately through
[GitHub Security Advisories](https://github.com/AIdhirajSingh/clauderabbit/security/advisories/new)
so it can be fixed before it's disclosed.

## Code of Conduct

Participation in this project is governed by the [Code of Conduct](CODE_OF_CONDUCT.md). By taking
part, you agree to uphold it.
