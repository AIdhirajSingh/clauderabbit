# Claude Rabbit, Product North Star

> Open source ships malware, too. We run the code in a disposable sandbox and show you exactly what it does.

---

## The reality we're building into

Open source is no longer a corner of software, it *is* software. As of GitHub's Octoverse 2025, the platform hosts 630 million total repositories, 395 million of them public, and over 180 million developers, with more than 36 million joining in the past year alone, roughly one new developer every second. Developers now create 230+ new repositories every minute. The raw surface area of "code a stranger can run" has never been larger, and it is compounding.

That same growth is the attacker's tailwind. Sonatype's 2026 State of the Software Supply Chain report cataloged more than 454,600 new malicious open-source packages in 2025, a 75% jump year over year, pushing the cumulative count of known malicious packages past 1.23 million. Over 99% of that malware now lives on npm. And 2026 is worse, not better: one industry corpus that tracked 14 campaigns across all of 2025 recorded 37 campaigns in the first half of 2026 alone, 4.5× the malicious-package volume of the entire prior year, with May 2026 the busiest month ever measured.

The shape of the threat is what makes our product necessary. These are not dusty CVEs sitting in a database. The dominant pattern is *install-time execution*: a package or repo that runs hostile code the moment you type `npm install` or `pip install`, harvesting GitHub tokens, cloud credentials, SSH keys, and crypto wallets before a build even completes. The Shai-Hulud worm and its 2026 descendants (Miasma, Hades) self-replicate, republishing themselves through any developer they touch. A favorite delivery method is brutally human: a fake recruiter sends a candidate a "take-home" repo to clone and run, and the repo quietly drains their machine. Crucially, across dozens of these campaigns, the CVE count during active exploitation was *zero*. Every tool that waits for a disclosed vulnerability is, by definition, looking the wrong way.

Now read the other half of the story, the developers. Walk any GitHub community thread or programming forum and you find the same confession over and over: someone downloaded a repo, ran it, and only afterward wondered if they should have. They admit they decide whether to trust a project on "gut feeling", stars, a clean README, a vibe. The honest ones spin up a throwaway VM or a Docker container when something feels off, but most don't, because it's friction they'll skip under deadline. There is a real, daily, unmet anxiety: *I am about to run this. Is it going to hurt me?* Nobody has built the obvious answer to that question for the individual. That gap is the entire opportunity.

## What the product is

Claude Rabbit is a free web tool. Scanning is free and unlimited, with no login ever required, a deliberate, settled decision (an earlier login-wall-plus-demo-ad gate was removed as fake scaffolding that contradicted the product's own honesty rail). You paste any public GitHub link, a repo or a fork, or an npm package you're about to install, which we resolve to and scan as its *real published registry artifact* (the exact tarball `npm install` fetches, integrity-verified, not merely the GitHub repo its manifest happens to link to). Either way you get back a single, honest verdict: a score out of 100 and a plain-language report telling you what the project is, what it actually did when we ran it, and what we couldn't verify. Signing in is optional and only saves your scan history.

The install-time, condition-triggered behavior that defines modern open-source malware is invisible to anything that only *reads* source and guesses at intent, static scanners, package-reputation tools, and the existing free repo-checkers are all structurally blind to it. **So we don't guess; we run it.** Claude Rabbit clones the repo into a disposable, isolated cloud sandbox and actually executes it, and watches what happens. That is the distinction, and nobody serves it to this audience.

The audience is deliberately wide: anyone who wants safety from malicious open source. A student cloning a tutorial. A solo developer evaluating a library. A team lead vetting a dependency. A company doing a quick gut-check before adoption. An autonomous AI coding agent about to clone-and-run with no human watching. We do not narrow it, because the anxiety is universal.

## How it works, end to end

A user arrives at a clean, near-empty interface dominated by one thing: a large input field that says *paste a GitHub link*. No dashboard to learn, no account wall, no settings. The entire product is one action. The web app is built on Next.js, server-rendered report pages double as the SEO surface, and the same framework serves the homepage, the public `/owner/repo` reports, and the API routes that orchestrate a scan.

Every scan runs the code. There is one pipeline, in one Vercel function, with a target of about 8 seconds on a small package with a warm mirror. (ClaudeRabbit 1.x sent only a minority of scans to the sandbox; 2.0 runs every scan. The binding contract is `docs/2.0/DESIGN.md`.)

**Cache first.** The backend checks the cache by commit SHA (or npm version plus integrity). If this exact state has been scanned, the stored report and its recorded event stream come back at once.

**Fetch, never clone.** On a miss, the GitHub tarball or the npm registry tarball is fetched into memory and verified (npm `dist.integrity`, GitHub archive commit). Four branches then run in parallel: static scanners (Semgrep, YARA, GuardDog, an OSV malicious-package lookup on every dependency, and in-process heuristics); a reachability graph of the code that runs at install or import time; three model readers with structured output on that slice (install surface, flagged code, README versus code); and the detonation.

**Detonation.** A fresh E2B sandbox starts from a pinned template. A forge runs as root inside it and every outbound connection from the repo's user is redirected to it, so every call the code makes is answered by us and recorded. The repo runs as a non-root user: a full install with every dependency and every script (npm with scripts on, uv for Python), through a package mirror used for speed and never trusted, then the install hooks and the entry point under a fast fake clock. Forensics (forged calls, files, processes, checks) are read out as root and the sandbox is destroyed. This is the layer that catches CVE-zero, install-time, condition-triggered malware that reading alone misses, and if the repo attacks the sandbox, that attempt is the detection signal.

The sandbox is the most safety-critical piece. It holds no real credentials, the forge answers every outbound call so no real request leaves on the repo's behalf, resources are capped, and it is **a fresh, disposable VM every single scan**, never reused. That is the abuse protection: nothing a malicious repo does persists, and no attacker can use the box as durable compute. The worst a hostile repo can attack is an empty room about to be demolished.

**The number is computed in code.** A deterministic formula (`lib/engine/score.ts`) produces the score from five separate groups: behaviour, intel, static, docs and reputation. Behaviour outweighs static. Code that never runs at install or import (tests, docs, infra) never lowers the score. The doc-versus-code distinction stays: a README that mentions `~/.aws/credentials` is context, not credential theft. The model supplies evidence and writes the report; code decides the number.

The scan produces one output: a single score out of 100 with the reasoning shown, the report separating *reputation* signals from *code and behavior* signals. The report never states a bare "Safe." It says what we observed and, honestly, what we couldn't: "no malicious behavior observed in our tests; project built and ran; owner account is new." That honesty is not a disclaimer bolted on the end, it is the core of the product's trustworthiness, and the one thing that protects us from the only story that could kill us: a confident "Safe" that turns out wrong.

## The intelligence layer: never do the same work twice

Scans cost real compute, and the same popular repositories will be checked thousands of times. So the system is stateful by design.

If a repository has already been scanned and hasn't changed, we do not re-run it. We serve the existing report instantly, fast for the user, free for us. If the repository *has* changed since we last looked, we don't start over either: we pull only the git diffs and update the existing report to reflect what's new, re-running the parts of the analysis the changes actually touch. A repo's report is therefore a living document that stays current as the project evolves, while the expensive work happens only when there is genuinely new code to understand. This single rule is what lets a free product survive virality instead of being bankrupted by it, a real, open question independent of caching, since there is currently no revenue mechanism at all (an earlier ad-gated model was removed as fake scaffolding; see the cost/unit-economics doc for the honest current numbers).

## The homepage as the viral engine

The front door is not just a utility, it's the growth engine, and it's built to be watched.

The homepage carries the global search bar at its center, but around it lives a living feed of the platform's activity: projects scanned moments ago, repositories spiking in scan volume, and the thing people can't look away from, a public leaderboard of the most dangerous repositories the system has caught. Malware, named and ranked. This is inherently shareable content; "the most dangerous repos on GitHub right now, found by an AI that ran them" is a headline that travels on its own, and it doubles as a live proof that the product works.

The mirror image of the danger board is the **trust badge**. Any repository that comes back clean can display a Claude Rabbit badge on its README and profile, a small, linkable mark that opens its full public report. For the repo owner it's a credibility signal they control. For us it's the cleanest distribution mechanic there is: every badge is a billboard on someone else's project, and every clean maintainer who adds one is advertising us to their users for free. We pair it with a zero-friction URL trick, swap the domain on any GitHub link to pull up that repo's Claude Rabbit report, so checking a project is a reflex, not a destination.

## The reports: generated live, exported anywhere

Here is our core design innovation. The reports are not rigid templates filled with values. They are generated on the frontend from a baseline design specification, `design.md`, the shipped Claude Design spec that lives in the repo and encodes our exact visual language, type, spacing, and components. The frontend produces a report layout that conforms to that spec while adapting to each project's specific findings, so every report is custom-built to its subject yet unmistakably ours. A tiny CLI tool's report and a sprawling framework's report look like members of the same family but neither feels like a form.

The example reports that ship with the design are made live by the build: it wires them to real scan findings so the layout is generated against actual data rather than placeholder content. To keep this fast and cheap, common boilerplate, background, shared chrome, repeated structure that is the same on every report, is cached and reused rather than regenerated each time; only the parts that genuinely differ per repo are produced fresh. The result is reports that are genuinely striking to look at, generated efficiently, and a beautiful report is a shared report.

Every report cleanly handles one-click export to three formats: a polished PDF, a standalone self-contained HTML file, and a shareable web link. A developer can drop the PDF in a security review, embed the HTML, or paste the link in a Slack channel, the verdict travels in whatever shape the moment needs.

## The growth engine: programmatic SEO

The final piece is structural and compounding. Every report we generate is public and permanently hosted at a clean, predictable URL: `ourdomain/owner/repo-name`. This is not a side effect, it is the long-term acquisition strategy.

Developers Google their safety questions. They search a specific repository's name to find out if it's legitimate, how to set it up, what it actually does, whether others have been burned by it. Today they land on scattered forum threads and guesswork. Tomorrow, for any repository anyone has ever scanned, they land on a deeply detailed, well-structured Claude Rabbit report that answers exactly that question, what the project is, how to run it, and whether it's safe. Because every public repo is a potential page and every page targets a real, intent-loaded query, the surface grows automatically with usage: each scan plants a permanent asset that pulls organic traffic indefinitely. The product's own activity is its marketing budget. As the open-source universe expands by 230 repositories a minute, so does our index of answers about it.

## Where the scan lives: at the moment of install

The web app is one surface, but the anxiety it answers, *I am about to run this, is it going to hurt me?*, lives at the terminal and inside the coding agent, in the seconds before `npm install` or `git clone`. So the same scan pipeline is shipped to exactly those places, as the primary growth channel for a free, ad-free tool:

- **A CLI (`clauderabbit`), published to npm.** `clauderabbit scan owner/repo` (or an npm package name) prints the honest verdict in the terminal, cache-aware, so an already-scanned repo comes back instantly and a new one gets a real scan, with no separate command to choose between the two. Requires a signed-in ClaudeRabbit account, persisted after the first login. (An earlier opt-in shell-hook feature that wrapped `npm install`/`pnpm install`/`git clone` directly was built and then removed after recognizing it scanned a package's linked GitHub repo, not the actual published registry artifact, the exact gap an install-time check most needs to close against a compromised-maintainer attack. That real-published-artifact scanning now *exists* in the pipeline: a pasted npm package is resolved to its actual published tarball, integrity-verified against the registry's own digest, and scanned as those real bytes, with an install hook present in the tarball but absent from its linked source surfaced as a compromised-publish signal, and its public report lives at `/npm/<package>`. What has *not* been rebuilt is the shell-hook install-time delivery surface itself; it will be planned and built properly on top of that real-artifact scanning, not shipped with the old gap.)
- **An MCP server.** An AI coding tool speaking the Model Context Protocol gets one cache-aware `scan` tool, so an autonomous agent about to clone-and-run a stranger's repo can check it first, over stdio (or remotely over Streamable HTTP for claude.ai custom connectors), against the same production scan API. The agent audience in the "reality we're building into" section is not hypothetical; this is how we reach it.

Every one of these honors the same rails as the web report: it separates reputation from code/behavior, it reports whether the sandbox actually ran (keyed to a real forensic record, never merely to the escalation flag), and it never states a bare "Safe." They are built and in the repo (`cli/`, `mcp-server/`), a distribution layer over the one pipeline, not a fork of it. (A Claude Code plugin approach was tried and dropped; the CLI and MCP server are the supported surfaces.)

## What we are, in one breath

Claude Rabbit is the place you check before you run. A clean field, a pasted link, a sandbox that runs the code so your machine doesn't have to, and an honest score you can trust, share, and find on Google. In a year when malicious packages crossed 454,600 and the attacks that matter carry no CVE at all, the only way to know what code does is to watch it do it. That is the whole product, and it is the one thing nobody is building for the 180 million developers who need it.
