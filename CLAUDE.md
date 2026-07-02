# CLAUDE.md — Claude Rabbit

This file is the project constitution. It is read every session and it is binding. The rules here are not suggestions, not defaults, and not subject to your judgment to skip. Where this file states a rule, you follow it exactly. You do not excuse, defer, reinterpret, or limit yourself out of any rule in this file. If a rule here seems hard, that does not make it optional — it makes it the work.

Your universal engineering method (research, plan-and-audit, per-file and per-unit verification, persistent context, per-unit git, total ownership) is already in force via the global protocol. This file does not repeat it. This file holds only what is specific and non-negotiable to Claude Rabbit.

Infrastructure facts — accounts, services, GCP, the $300 credit, secrets, the Gemini-via-Vertex backend, model strings — are **not** in this file. They live in **`docs/INFRASTRUCTURE.md`** at the repo root. This file is the SOP (the rules); `docs/INFRASTRUCTURE.md` is the reference (the facts). Read `docs/INFRASTRUCTURE.md` before any work that touches infra, and treat its facts as authoritative — do not guess or re-derive them.

---

## What Claude Rabbit is

A free, open-source, no-login web tool. A person pastes a public GitHub repo, fork, or dependency link. The system reads the code, checks reputation, and runs it in an isolated sandbox when warranted, then returns a single 0–100 safety score with an honest, plain-language report. The report is public and permanent at `/owner/repo`, shareable, and embeddable as a trust badge.

The wedge, and the one thing protected at all costs: **everyone else reads the code; we run it.** Running unknown code in a throwaway sandbox to observe real behavior is the differentiator. Nothing in the build is allowed to quietly erode it.

The architecture is a two-speed funnel: roughly 95% of scans resolve on a fast path (static scanners + a fast model reading only flagged regions + reputation lookup), and roughly 5% escalate to the deep dynamic sandbox run. That ratio is a load-bearing assumption for both performance and cost.

The goal is not profit. The goal is: self-sustaining without debt, then viral, then acquisition. The accumulating database of vetted repos is the real asset. Build accordingly.

---

## Non-negotiable safety rails

These two rails are product-defining. Violating either is the kind of failure that ends the product. They override convenience, speed, and any instinct to simplify.

1. **Never state a bare "Safe."** No screen, report, score, or message ever declares a flat "Safe." Every verdict shows the evidence behind it and states plainly what was *not* verified — for example, "no malicious behavior observed in our tests; owner account is new." The score and one-word verdict carry nuance, never false certainty. A confident wrong "Safe" is the single outcome that can kill this product. Treat that as literal.

2. **The sandbox is hermetic and reset every scan.** It holds no real credentials, its network egress is locked down, its resources are capped, and it is reimaged to a clean state after every single scan. That reset is the abuse protection — a caught attack must hit an empty room about to be demolished. Getting isolation subtly wrong turns the sandbox into a weapon. This is the most safety-critical code in the product and is treated with the most care.

Also structural, everywhere a verdict is explained: **reputation signals and code/behavior signals are kept separate.** Owner history, account age, stars, sentiment are one thing; what the code does and what running it revealed are another. The user must always be able to tell which is which.

---

## Secrets architecture — absolute

This has real security consequences and is always in force. The exact secret names, the service-account method, and all infra facts live in **`docs/INFRASTRUCTURE.md`** — read it. The binding rules are here:

- **All model, search, and cloud credentials live in Supabase edge-function secrets, server-side. Never client-side. Never in the repo.** Every scan, score blend, and model/search call happens in edge functions where the keys live.
- The client holds only the Supabase URL and the Supabase **publishable** key. Nothing else. The app points at Supabase; Supabase holds the rest.
- **Never commit `.env`, `.env.local`, `.env*`, or `*-key.json`.** Confirm `.gitignore` covers them before any commit that could touch them.
- Service-account keys are disposable: if one is lost or exposed, rotate it (new key, delete old) — never back one up or copy it outside Supabase secrets.

If you are ever about to place a real key anywhere a client or the repo could see it, stop. That is the one move this section exists to prevent. For which secrets exist and how the edge function reads them, see `docs/INFRASTRUCTURE.md`.

---

## Environment — the facts, do not re-derive or guess

The exact accounts, project IDs, regions, secret names, model strings, the Gemini-via-Vertex backend, and the GCP credit all live in **`docs/INFRASTRUCTURE.md`**. Read it before doing anything that touches infra; do not guess these facts. The binding architectural rules are here:

- **Framework: Next.js (App Router).** Server-rendered report pages are the SEO surface. The same app serves the homepage, the public `/owner/repo` reports, and the API routes that orchestrate scans. This is the framework for the entire web layer. Do not substitute another.
- **Supabase** provides database, auth (Google + email), and edge functions. All scanning, score blending, model/search calls, and DB writes happen in edge functions (Deno/TypeScript).
- **Gemini is the placeholder model**, called via the **Vertex backend** (see `docs/INFRASTRUCTURE.md` for SDK, auth, and why Vertex not AI Studio), wired through the fast-path edge function to prove the end-to-end pipe. The real models (DeepSeek fast-path, Brave reputation, Kimi K2.7 + OpenCode in the sandbox) swap in once the flow works, behind a clean seam. Swapping the model proves the wrapper; the dynamic sandbox engine is a separate, harder thing and is the real product.

---

## The UI: full code port, not a reinterpretation

The design is already built. It is the **Claude Design export** (React/HTML/CSS/JS), and it is **dual-theme** — a light theme and a dark theme, with system-default detection and a manual toggle, the choice persisted. It is the design to use — the design language, the screens, the components, the motion, the score-color logic are all decided and are not to be redesigned, reinterpreted, or "improved" on your own initiative.

**Port the actual code. Do not rebuild from intent.** Since the design output is React and the framework is Next.js App Router, you port the real components into the App Router — the exact markup, styles, structure, and behavior — not a fresh approximation of what the screens look like. The shipped design is the source of truth for the frontend. If something must change to fit Next.js, you make the minimal faithful adaptation and you preserve the design exactly; you do not take it as license to redesign.

**The reports are generated on the frontend from `design.md`, not from JSON.** `design.md` is the shipped Claude Design spec and it lives in the repo root — commit it correctly. The example reports that ship with the design are made live: you wire them to real scan findings so the report layout is generated against actual data, conforming to `design.md` while adapting per repo. There is no JSON-verdict-rendered-into-a-shell model. To keep generation fast and cheap, common boilerplate that is the same on every report (background, shared chrome, repeated structure) is cached and reused rather than regenerated each time; only the parts that genuinely differ per repo are produced fresh.

The score-color logic is fixed everywhere a score appears: green = high/secure, blue = upper-middle, yellow = warning, red = low/dangerous. It is consistent across every surface and holds in both themes.

---

## Code quality standard

Production-grade, every file, no exceptions. This is a security product; the bar is higher, not lower.

- No placeholder logic, no stubbed "TODO later" in shipped paths, no fake data standing in for real behavior in the actual product flow.
- No shortcuts taken to look finished faster. "It renders" is not "it works."
- Correct, clear, secure, tested by running — held to the verification gates of the global protocol, with extra care on anything touching the sandbox, secrets, or the verdict.
- You do not lower the standard because something is tedious, and you do not declare done what you have not verified.

---

## No excuses, no deferral, no self-limiting

This is binding and it is the rule most often broken under pressure.

- **You do not defer the hard parts.** The sandbox that runs unknown repos is the moat and it is in V1. You do not stub it, skip it, fake it, or push it to "later" to make progress look faster. A beautiful wrapper with no working engine is not the product.
- **You do not excuse a gap.** If something is not done or not working, you fix it. You do not explain why it is acceptable as-is when this file says it must be done.
- **You do not limit yourself on imagined constraints.** You do not decide something is impossible, too hard, or out of reach before establishing that by actually trying.
- **You do not narrow scope to dodge difficulty.** What V1 includes is below; you build all of it.

If you find yourself reframing a requirement to make it easier or softer than written, that reframing is the signal to stop and do it as written.

---

## Build order for this product

The global protocol says build in dependency order. For Claude Rabbit specifically, that order is:

1. **Wrapper first** — Next.js app, port the Claude Design UI, Supabase auth + database + edge functions, ad integration, report rendering, cache, and the Gemini fast-path proving the end-to-end pipe (paste → edge function → model reads/scores → report renders).
2. **Then the sandbox engine** — the GCP golden image, the auto-build/run harness, isolation and reset, escalation. This is the real product and the real test.

A working wrapper with a model rendering scores is a **milestone, not a finished product.** The thing that makes Claude Rabbit real and acquirable is the sandbox actually building and running strangers' repos safely. Do not treat the wrapper being done as the work being done.

Two numbers prove or kill the moat and must be measured on real runs, not estimated: the **auto-build success rate** (does a real repo clone, build, and run unattended) and the **real escalation rate** (is ~5% the true ambiguous rate). Measure them early, before over-investing in the wrapper around them.

---

## V1 scope — build this, not more, not less

**In V1:** paste-a-URL → fast safety verdict, first scan free with no login or ad; two-speed analysis with the dynamic sandbox working well enough on a meaningful share of real repos; public SEO-indexed `/owner/repo` reports with trust badge; cache by commit SHA + owner-cached reputation; ads (after the first scan, one rewarded video gates each result — fresh scans and cached views alike); verdicts that never say a bare "Safe"; homepage with live scans, viral repos, and the dangerous-repos leaderboard.

**Login / limits / ads:** first scan free, no login, no ad. After that, login is required and a 15-second rewarded ad gates each result — every fresh scan and every cached report view alike. Daily limits tracked by login + device: 3 stage-1 scans/day, 1 dynamic scan/day. "Unlimited" means unlimited cached views (each still ad-gated after the first scan) and generously rate-limited fresh deep scans — never unlimited unmetered deep scans.

**Distribution surfaces — shipped, now real (scope expansion beyond the original V1 plan, authorized by direct instruction as "the primary growth channel for a free ad-free product"):** a real **MCP server** (`mcp-server/`, `scan_repo`/`get_report` tools over stdio, calling the production Supabase scan API), a real **CLI** (`cli/`, package `claude-rabbit-cli`, with `scan`/`report`/`npm-install`/`pnpm-install`/`git-clone` subcommands and opt-in shell hooks that scan before install/clone), and a real **Claude Code plugin** (`plugins/claude-rabbit/`, a `scan-repo` skill plus a `PreToolUse` Bash hook that intercepts install/clone commands). These are built, in the repo, and reuse the same server-side scan pipeline — they are not roadmap. Each honors the same rails as the web app: honest verdict, never a bare "Safe."

**Not in V1 (do not build, do not drift into):** no code-quality/refactoring review, no subscriptions, no accounts/dashboards beyond simple login, no Hugging Face/model scanning, no leaderboard moderation tooling beyond basic display. These are roadmap, not V1.

---

## Running and previewing

The app is currently previewed and run on **localhost:2311**.

Do not pre-write a table of commands ahead of the real work. Commands are derived from the actual project — `package.json`, the Supabase config, the real scripts — at the moment you need them, not guessed in advance. Read the real config and run the real command when the task calls for it.

---

## The one thing to hold

The wrapper is straightforward; the moat is the sandbox that runs unknown repos. Build the wrapper fast and well, port the design faithfully, keep the secrets server-side, never ship a bare "Safe," and then go prove the engine. That proof — real auto-build success and real escalation rate — is what turns this from a beautiful landing page into a product worth acquiring.
