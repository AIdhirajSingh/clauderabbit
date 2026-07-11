# Getting started with ClaudeRabbit

A step-by-step guide to scanning repos and packages from your terminal, and to letting an AI
agent (like Claude) scan them for you. No prior experience with any of this is assumed — every
command below can be copy-pasted as-is.

You'll need [Node.js](https://nodejs.org) installed (version 18 or newer) to use the CLI or MCP
server. If you just want to scan something right now without installing anything, go to
**[clauderabbit.in](https://clauderabbit.in)** and paste a link — everything below is for the
terminal / AI-agent workflow.

---

## 1. Install the CLI

Open a terminal and run:

```bash
npm install -g clauderabbit
```

This installs a `clauderabbit` command on your machine, globally (the `-g` flag), so you can run
it from any folder.

**Confirm it installed** by asking it for its version:

```bash
clauderabbit version
```

You should see a version number printed, like `0.1.7` (or newer). If instead you see "command not found",
your terminal's `PATH` doesn't include npm's global bin folder — closing and reopening your
terminal usually fixes this.

**Log in.** The CLI needs a (free) ClaudeRabbit account so it can save your scan history — scanning
itself is always free and unlimited:

```bash
clauderabbit login
```

This opens your browser to a ClaudeRabbit sign-in page. Sign in with Google or email, and the
terminal will print `Signed in.` once it's done. You only need to do this once — the CLI remembers
you until you run `clauderabbit logout`.

---

## 2. Run a scan

**Scanning a GitHub repository** — pass it as `owner/repo`:

```bash
clauderabbit scan expressjs/express
```

**Scanning an npm package** — pass just the package name:

```bash
clauderabbit scan left-pad
```

(For npm, ClaudeRabbit scans the *actual published package* — the real bytes `npm install` would
download — not just the GitHub repo it links to. That distinction matters: a compromised
maintainer can publish something to npm that doesn't match what's on GitHub.)

**What the output looks like** (a real, live example — your own scan will show a live progress
list first, then a boxed summary like this):

```
╭─────────────────────────────────────────────╮
│ chalk/chalk                                 │
│                                             │
│ Score    100/100  (green (high / secure))   │
│ Verdict  Trusted                            │
│ Source   fresh scan just run @ aa06bb5ac3f1 │
╰─────────────────────────────────────────────╯

🔎 What was actually verified
  ○ STATIC READ ONLY: static scanners + a model read the source. No dynamic
    sandbox execution has produced a forensic record for this report.
  ...

👤 Reputation signals
  Owner:     chalk (chalk) — 11 yr, established, 16 public repos.
  Community: 23.3k stars, 1.0k forks, sentiment "Extremely positive" (100/100).

📋 Summary
  Chalk is a widely used, highly reputable, and well-maintained library...

Full report: https://clauderabbit.in/chalk/chalk
```

ClaudeRabbit never just says "Safe" — every report states plainly what it actually checked and
what it couldn't verify (e.g. whether the code was run in a live sandbox, or only read
statically). A link to the full public report page is always printed at the end.

Need machine-readable output instead (for a script)? Add `--json`:

```bash
clauderabbit scan expressjs/express --json
```

---

## 3. Install the MCP server (for AI coding agents)

The MCP server lets an AI agent — Claude Desktop, or any MCP-compatible tool — call ClaudeRabbit
itself, so it can check a dependency before cloning or installing it. It reuses the same sign-in
as the CLI, so if you already ran `clauderabbit login` above, you're already signed in for this too.

Wire it into **Claude Desktop** with one command:

```bash
clauderabbit mcp install
```

This finds your Claude Desktop config file automatically and adds a `clauderabbit` entry to it,
leaving every other server and setting untouched. You'll see a confirmation like:

```
Found Claude Desktop config at /path/to/claude_desktop_config.json
Updated the "clauderabbit" MCP server entry — every other server and setting already in the file was left untouched.
Restart Claude Desktop for this to take effect.
```

**Restart Claude Desktop** for the new server to load. After restarting, you can ask Claude
something like *"scan expressjs/express with ClaudeRabbit before I install it"* and it will call
the tool directly.

(Using a different MCP-compatible tool — Codex, Cursor, Windsurf, etc.? See
[mcp-server/README.md](../mcp-server/README.md#other-mcp-compatible-clients-codex-cursor-windsurf-etc)
for the manual config snippet; the shape is the same everywhere.)

---

## 4. Set up the MCP inside claude.ai Custom Connectors

This is a *separate* setup from step 3 — it connects the **web version of Claude** (claude.ai) to
ClaudeRabbit over the internet, instead of running locally on your machine. You don't need to have
done step 3 first; this works on its own.

1. Go to **[claude.ai](https://claude.ai)** and sign in.
2. Open **Settings → Connectors**.
3. Click **Add custom connector**.
4. In the URL field, paste exactly:
   ```
   https://clauderabbit.in/mcp
   ```
5. Confirm/save. Claude will redirect you through a ClaudeRabbit sign-in page (this is the same
   account as the CLI/Desktop MCP, so if you've already signed in elsewhere, this can be
   instant) — approve the connection.

**Confirm it's connected**: back in Settings → Connectors, the ClaudeRabbit entry should show as
connected/enabled (no red error state). If you don't see it listed as active, repeat step 3–5 —
a failed OAuth handshake is the most common cause and simply retrying resolves it.

**Run a scan from inside a Claude chat**: once connected, just ask, in plain language. It scans
both GitHub repos and npm packages — for example:

> Use ClaudeRabbit to scan the repo `expressjs/express` before I recommend it.

> Use ClaudeRabbit to scan the npm package `left-pad` before I add it.

Claude will call the `scan` tool itself and show you the score, verdict, and what was actually
verified — same honest, never-bare-"Safe" report as the CLI. (For npm, it scans the real
published package, not the GitHub repo its package.json links to.)

---

## 5. How to update

**Updating the CLI** (and the MCP server bundled inside it — installing the CLI already gives you
both):

```bash
npm install -g clauderabbit@latest
```

Confirm the update worked the same way you confirmed the install:

```bash
clauderabbit version
```

**Updating the claude.ai Custom Connector**: nothing to do on your end — `https://clauderabbit.in/mcp`
is a live, remotely-hosted server, so every chat you have automatically uses the current version.
If a connector ever looks disconnected after a ClaudeRabbit update, remove it and re-add it in
Settings → Connectors using the same URL from step 4.

---

Questions or something not working as documented here? See the main [README](../README.md), the
[CLI reference](../cli/README.md), or the [MCP server reference](../mcp-server/README.md) for
the full command/tool list.
