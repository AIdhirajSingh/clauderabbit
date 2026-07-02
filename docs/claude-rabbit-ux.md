# Claude Rabbit — UX Document

> Screens, elements, and flow. The visual design is already shipped (Claude Design export, dual-theme); the build ports it faithfully. This document governs which screens exist, what must be on them, and how they behave.

**The promise:** *Paste a repo, know if it's safe to run.* A person pastes a GitHub link, and Claude Rabbit reads it, runs it when warranted, and returns a single trustworthy safety score with an honest report — free, in seconds.

---

## Design direction

The visual design is already shipped. It was designed end-to-end in Claude Design and exported as production-ready React/HTML/CSS/JS. That export is the design — sophisticated, premium, minimal, editorial — and it is **dual-theme**: a light theme and a dark theme, with system-default detection and a manual toggle, the choice persisted. The design is its own identity; it is not modeled on any other product's look.

This is not a design brief to interpret. The shipped Claude Design export is the source of truth for everything visual: the fonts, the palette, the spacing, the components, the motion, the score-color logic. The screens and elements listed in this document describe *what must be present and how it behaves*; the shipped design defines *how it looks*. Where the two are both present, the shipped design wins on appearance and this document governs the elements, screens, and flows that must exist.

**The build does not redesign.** It ports the shipped Claude Design export faithfully into the framework — the actual components, markup, styles, and behavior — not a reinterpretation. Any change made to fit the framework is a minimal faithful adaptation that preserves the design exactly.

**Color is functional** — it carries meaning, above all in the score — and that logic holds in both themes.

**Loading animation (global):** a single, consistent loading animation is used **everywhere there is a load or wait** — processing, fetching, transitions, the ad-background work, anywhere content is pending. It is the shipped design's loader (a minimal animated dot grid), applied identically app-wide so loading always feels like one coherent system, in both themes.

---

## Rules the screens must honor

- **First scan: free, no login, no ad.** Value first.
- **After the first scan, login is required to continue — for every scan and for viewing any report, including a cached one.** Once the first free scan is used, there is no further access without login.
- **A 15-second ad runs on every scan after the first, and on viewing a cached report after the first scan.** After the first free scan, seeing a result — fresh or cached — requires the ad and login. (The cached *compute* is still free to us; the ad and login gate still apply to the view.)
- **Daily limits, tracked by login + device: 3 stage-1 scans/day, 1 dynamic scan/day.**
- **Score color logic** (used everywhere a score appears): green = high / secure, blue = upper-middle, yellow = warning, red = low / dangerous. Holds in both light and dark themes.

---

## Cross-cutting behaviors

Recurring behaviors that span screens. Defined once here, referenced by name.

### A. Scan, understanding after
A scan is never instant — it processes. After paste (and the ad, when applicable), the repo enters a **processing** state with the global loader and the live-log timeline, then resolves into a finished Report. The same item may appear in Dashboard history in a processing state and resolve into a clickable report once done.

### B. Cached scans return instantly
A repo already scanned at its current state returns its existing Report **immediately** — no processing, no ad-funded compute on our side. The repeat scan should feel instant, distinct from a fresh scan's processing flow. Note: "instant" refers to compute — after the user's first free scan, viewing any report (including a cached one) still requires login and the ad per the rules above. The instantness is in skipping the processing pipeline, not in skipping the gate.

### C. Never a bare "Safe"
No screen ever states a flat "Safe." The verdict always shows evidence and what was **not** verified ("no malicious behavior observed in our tests; owner account is new"). The score and one-word verdict carry nuance, never false certainty.

### D. Reputation and code are separate signals
Everywhere the verdict is explained, **reputation** signals (owner history, account age, stars, sentiment) are kept visually and structurally distinct from **code & behavior** signals (what the code does, what running it revealed). The user should always be able to tell which is which.

### E. Failed scan keeps the attempt
If a scan can't complete, it shows a **failed** state with a retry action and a clear note that nothing was lost — never a dead end.

---

## Screens

### 1. Home / Scan
The whole product is one action.
- **Top nav:** wordmark (left); right side: GitHub repo link with **live star count fetched and shown**, and Login.
- **Centered hero:** headline + one-line subhead.
- **Prompt bar:** large centered input to paste a GitHub repo link — the dominant element.
- **On scroll, in order:** Leaderboard (most dangerous repos; with an open-full-screen control) → "What is Claude Rabbit" + use cases → Star on GitHub button / request.

### 2. Ad
- 15-second ad with a visible countdown (placeholder ad for now). Shown on every scan after the first.
- Repo processes in the background during the ad. On finish → Report if ready, else Processing.

### 3. Processing
- **Beautified live logs** as a **vertical, chapter-wise timeline** (clone → static scan → reputation → read → [escalation] → dynamic run). Placeholder log content.
- Transitions to the Report when done.

### 4. Report
The report is generated on the frontend from the shipped Claude Design `design.md` (the design spec in the repo), adapting to each repo's findings rather than filling a rigid template. Common boilerplate (background, shared chrome, repeated structure) is cached so it is not regenerated every time; only the parts that differ per repo are produced fresh. The elements below must always be present in the generated report.
- **One-word verdict** and a **numeric score /100** with the score-color logic.
- **Quick summary.**
- **Sections:** owner history · reputation (owner + repo) · repo stats (lines of code, packages, stars, creation date) · per-package scoring · risky items · final verdict.
- **Full end-to-end logs** viewable, plus a logs summary.
- **Export:** PDF, standalone self-contained HTML, and a shareable web link.
- (Auto-publishes to a public `/owner/repo` page — not a screen the designer builds.)

### 5. Leaderboard (full-screen)
- Standalone view, reachable from the nav or the home full-screen control.
- Ranked list of the most dangerous repos found, scores shown with the color logic.

### 6. Login
- Clean, minimal login screen, in the shipped design's light or dark theme per the active theme.

### 7. Dashboard (sidebar app)
- **Sidebar:** navigation including a **dedicated Leaderboard button** (opens the leaderboard); **user stats** (repos scanned, "protected you from N repos"); **profile** (name, avatar).
- **Default panel:** the same scan-any-repo paste screen, inside the app shell.
- **History:** list of past scans grouped by time; **clicking a scan opens its Report.**

### 8. Profile
- View and **edit** name / details.
- See the same user stats.
- **Log out / sign out.**

---

**Eight screens total:** Home, Ad, Processing, Report, Leaderboard, Login, Dashboard, Profile. That is the whole app. The shipped Claude Design export defines how every screen looks in both themes; this document defines the elements, screens, and flows that must exist. The build ports the shipped design faithfully and does not redesign it.

---

## Clickable flows the prototype should support

- Home → paste repo → (first scan: no ad) → Processing → Report
- Home → paste repo → (subsequent scan) → Ad (15s) → Processing or Report
- Home → paste an already-scanned repo → (first scan: instant Report) / (after first scan: Login + Ad → Report instantly, no processing) (behavior B)
- Report → open full end-to-end logs → back to Report
- Home → scroll → Leaderboard → open full-screen Leaderboard
- Home → scroll → "What is Claude Rabbit" → Star on GitHub
- After first scan → Login → Dashboard
- Dashboard → paste repo (default panel) → Processing → Report
- Dashboard → History → click a past scan → its Report
- Dashboard → sidebar Leaderboard button → Leaderboard
- Dashboard → Profile → edit name → save
- Profile → log out → Login/Home
- Processing → failed state → retry (behavior E)

## Content to populate with

Realistic, believable scan data so the prototype reads as real, never lorem-ipsum:
- **Repos:** a popular well-known OSS library (high score, green), a mid-trust utility (blue), a sketchy new-owner tool with a fat install script (yellow/red), an obfuscated crypto-related repo (red), a clean personal project (green).
- **Scores:** spread across the color bands — e.g. 96, 88, 71, 44, 18 — never all one color.
- **Owner history:** an established maintainer with years of activity vs. a three-day-old account with one polished repo.
- **Repo stats:** plausible lines-of-code, package counts, star counts, creation dates.
- **Risky items / per-package scoring:** named packages with believable findings (an install hook that phones home, an unexpected network call, a credential-reading snippet, an unmaintained dependency).
- **Leaderboard:** several dangerous repos with low scores and short reasons.
- **Verdicts:** honest phrasings per behavior C ("no malicious behavior observed; owner account is new"; "active install-time network call to an unknown host — do not run").
No real private individuals or real defamatory attribution of malice to actual named people/projects — use plausible invented repo and owner names.

## The small things

Quiet interactions that make it feel effortless:
- Going back from an opened report or item returns to the exact scroll position left.
- The app feels quick to load; cached scans feel instant.
- The same global loader appears anywhere there is a wait.
- Score color is consistent everywhere a score appears.

## Out of scope (do not build)

No subscriptions or pricing screens, no code-quality / refactoring review, no accounts beyond the simple login, no Hugging Face / model scanning, no settings suite, no leaderboard moderation tooling. Login and Dashboard exist as specified here; nothing more elaborate.

Note: this document governs the **web app's eight screens** only. The CLI, MCP server, and Claude Code plugin that ship alongside it (`cli/`, `mcp-server/`, `plugins/claude-rabbit/`) are separate distribution surfaces with no web UI — they are real and in the repo, but they are terminal/agent surfaces, not screens, so they are simply outside this document's remit rather than out of the product's scope.
