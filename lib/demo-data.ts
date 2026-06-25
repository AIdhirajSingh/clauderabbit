/**
 * Demo / seed fixture data — ported verbatim from the Claude Design prototype
 * (`design-source/Claude Rabbit.dc.html`, REPOS / LEADERBOARD / ACTIVITY /
 * useCases / suggestions / DEMO_ORDER, lines ~1009–1112 and ~1280–1290).
 *
 * The strings are copied exactly — scores, the honest verdict phrasings, and
 * the risky-item details are content decided by the design and are not to be
 * invented or "improved" here.
 */

import type {
  ActivityEntry,
  LeaderboardEntry,
  Report,
  UseCase,
} from "./types";

/** All demo reports, keyed by id (mirrors the prototype's REPOS object). */
export const REPOS: Record<string, Report> = {
  r1: {
    id: "r1",
    owner: "verdant",
    name: "ratchet",
    score: 96,
    verdict: "Trusted",
    cached: true,
    deep: false,
    summary:
      "A mature HTTP router for Node. Built and ran cleanly in our static pass; no install hooks, no network calls at install, no credential access. Maintained by an established author with a long track record.",
    ownerHistory: {
      handle: "soren-vestergaard",
      name: "Søren Vestergaard",
      age: "8 yr 2 mo",
      established: true,
      repos: 64,
      note: "Long-standing maintainer; consistent commit history across years.",
    },
    reputation: {
      stars: "41.2k",
      forks: "2.7k",
      sentiment: "Widely trusted, referenced across tutorials and production stacks.",
      sentScore: 96,
    },
    stats: { loc: "14,820", packages: 7, stars: "41.2k", created: "Mar 2018" },
    packages: [
      { name: "@verdant/ratchet", score: 96, note: "Core package. No suspicious calls." },
      { name: "path-to-regexp", score: 94, note: "Well-known, actively maintained." },
      { name: "negotiator", score: 92, note: "Stable dependency." },
    ],
    risky: [],
    logs: [
      {
        ch: "Clone",
        kind: "ok",
        lines: [
          "Resolved verdant/ratchet@a91f3c to commit SHA",
          "Shallow clone complete · 14,820 lines across 96 files",
        ],
      },
      {
        ch: "Static scan",
        kind: "ok",
        lines: [
          "ClamAV signatures: 0 hits",
          "Semgrep patterns: 0 findings",
          "YARA rules: 0 matches",
          "No install hooks detected in package.json",
        ],
      },
      {
        ch: "Reputation",
        kind: "ok",
        lines: [
          "Owner account age: 8 yr 2 mo",
          "Brave search: 41.2k stars, strong community sentiment",
          "Owner cache hit, skipped redundant lookup",
        ],
      },
      {
        ch: "Read",
        kind: "ok",
        lines: [
          "Read model flagged regions: none",
          "Confidence: 0.97 clean, no escalation",
          "Verdict blended to 96 / 100",
        ],
      },
    ],
  },

  r6: {
    id: "r6",
    owner: "ana-mirza",
    name: "pomodoro-cli",
    score: 94,
    verdict: "Trusted",
    cached: true,
    deep: false,
    summary:
      "A small personal Pomodoro timer for the terminal. Single dependency, no network activity, no install scripts. Clean, simple, and safe to run.",
    ownerHistory: {
      handle: "ana-mirza",
      name: "Ana Mirza",
      age: "3 yr 7 mo",
      established: true,
      repos: 21,
      note: "Active personal account with steady contribution history.",
    },
    reputation: {
      stars: "312",
      forks: "18",
      sentiment: "Small but clean personal project; no red flags found.",
      sentScore: 90,
    },
    stats: { loc: "840", packages: 2, stars: "312", created: "Sep 2023" },
    packages: [
      { name: "pomodoro-cli", score: 95, note: "No network, no secrets access." },
      { name: "chalk", score: 93, note: "Popular terminal color library." },
    ],
    risky: [],
    logs: [
      {
        ch: "Clone",
        kind: "ok",
        lines: [
          "Resolved ana-mirza/pomodoro-cli@7d22b1",
          "Clone complete · 840 lines across 11 files",
        ],
      },
      {
        ch: "Static scan",
        kind: "ok",
        lines: ["ClamAV: 0 · Semgrep: 0 · YARA: 0", "No postinstall scripts"],
      },
      {
        ch: "Reputation",
        kind: "ok",
        lines: ["Account age 3 yr 7 mo · 21 repos", "Low star count, but clean signal"],
      },
      {
        ch: "Read",
        kind: "ok",
        lines: ["No flagged regions", "Confidence 0.95 clean, shipped to 94 / 100"],
      },
    ],
  },

  r2: {
    id: "r2",
    owner: "marlow",
    name: "envguard",
    score: 88,
    verdict: "Likely safe",
    cached: false,
    deep: false,
    summary:
      "A configuration and environment-variable validator. Code read cleanly and reputation is solid, but the owner account is younger and one dependency is lightly maintained. No malicious behavior observed in our tests.",
    ownerHistory: {
      handle: "marlow-dev",
      name: "Marlow Okonkwo",
      age: "1 yr 4 mo",
      established: true,
      repos: 9,
      note: "Reasonable history; not yet long-established.",
    },
    reputation: {
      stars: "3.4k",
      forks: "190",
      sentiment: "Positive, growing adoption; no complaints surfaced.",
      sentScore: 85,
    },
    stats: { loc: "3,210", packages: 5, stars: "3.4k", created: "Feb 2025" },
    packages: [
      { name: "@marlow/envguard", score: 90, note: "Clean. Reads process.env only, no exfil." },
      { name: "dotenv", score: 92, note: "Ubiquitous, trusted." },
      { name: "fast-deep-equal", score: 88, note: "Stable." },
      { name: "tiny-glob", score: 74, note: "Lightly maintained, last release 14 mo ago." },
    ],
    risky: [
      {
        title: "Lightly maintained dependency",
        severity: "low",
        kind: "code",
        detail:
          "tiny-glob has had no release in 14 months. Not malicious, but unmaintained code is a standing risk.",
      },
    ],
    logs: [
      {
        ch: "Clone",
        kind: "ok",
        lines: [
          "Resolved marlow/envguard@c4e8a0",
          "Clone complete · 3,210 lines across 38 files",
        ],
      },
      {
        ch: "Static scan",
        kind: "warn",
        lines: [
          "ClamAV: 0 · YARA: 0",
          "Semgrep: 1 low-severity note (unmaintained dep)",
          "No install hooks",
        ],
      },
      {
        ch: "Reputation",
        kind: "ok",
        lines: [
          "Account age 1 yr 4 mo · 3.4k stars",
          "Brave search: positive sentiment, no incidents",
        ],
      },
      {
        ch: "Read",
        kind: "ok",
        lines: [
          "Read flagged region (tiny-glob usage)",
          "No exfil path · confidence 0.88 clean",
          "No escalation, 88 / 100",
        ],
      },
    ],
  },

  r3: {
    id: "r3",
    owner: "quickdev",
    name: "setup-helper",
    score: 71,
    verdict: "Caution",
    cached: false,
    deep: true,
    summary:
      "A one-command project bootstrapper with a large postinstall script. We escalated to a sandbox run. The install script contacts a telemetry endpoint and writes outside the project directory. No credential theft observed, but the install-time behavior is more than this tool needs.",
    ownerHistory: {
      handle: "quickdev-tools",
      name: "quickdev",
      age: "3 days",
      established: false,
      repos: 1,
      note: "Account created 3 days ago with a single, polished repo. Classic new-owner pattern.",
    },
    reputation: {
      stars: "1.1k",
      forks: "40",
      sentiment: "Sudden star spike inconsistent with account age; possible inflation.",
      sentScore: 48,
    },
    stats: { loc: "2,640", packages: 6, stars: "1.1k", created: "3 days ago" },
    packages: [
      { name: "setup-helper", score: 62, note: "Postinstall script writes to ~/.config and phones home." },
      { name: "node-fetch", score: 90, note: "Legit, but used by the install hook." },
      { name: "shelljs", score: 70, note: "Used to run shell commands during install." },
    ],
    risky: [
      {
        title: "Postinstall network call",
        severity: "med",
        kind: "behavior",
        detail:
          "During the sandbox run, the postinstall script sent a POST to telemetry.quickdev-cdn[.]net carrying machine hostname and npm config. Not credential theft, but undisclosed and unnecessary.",
      },
      {
        title: "Writes outside project root",
        severity: "med",
        kind: "behavior",
        detail:
          "Install wrote a launch agent to ~/.config/quickdev. Persistence behavior a bootstrapper does not need.",
      },
      {
        title: "Three-day-old owner",
        severity: "med",
        kind: "rep",
        detail: "Single polished repo on a brand-new account with an unnatural star spike.",
      },
    ],
    logs: [
      {
        ch: "Clone",
        kind: "ok",
        lines: [
          "Resolved quickdev/setup-helper@f0192a",
          "Clone complete · 2,640 lines across 27 files",
        ],
      },
      {
        ch: "Static scan",
        kind: "warn",
        lines: [
          "Semgrep: postinstall executes network + shell",
          "Secret scan: 0 embedded secrets",
          "Flagged: package.json scripts.postinstall",
        ],
      },
      {
        ch: "Reputation",
        kind: "warn",
        lines: [
          "Account age: 3 days",
          "Star spike vs age inconsistent, possible inflation",
          "Confidence to ship: 0.41, escalate",
        ],
      },
      {
        ch: "Escalation",
        kind: "warn",
        lines: [
          "Suspicion gate tripped: install-time network + new owner",
          "Provisioning sandbox VM from pool",
        ],
      },
      {
        ch: "Dynamic run",
        kind: "warn",
        lines: [
          "Agent ran npm install in isolated VM",
          "Observed POST to telemetry.quickdev-cdn[.]net",
          "Observed write to ~/.config/quickdev (launch agent)",
          "No credential or SSH key access observed",
          "VM reimaged to a clean state",
          "Blended to 71 / 100",
        ],
      },
    ],
  },

  r4: {
    id: "r4",
    owner: "corewallet",
    name: "keystore-tools",
    score: 44,
    verdict: "High risk",
    cached: false,
    deep: true,
    summary:
      "Marketed as a wallet keystore utility. In the sandbox it actively read SSH keys and shell history on first run. We could not verify any legitimate function that requires that access. Do not run this outside a throwaway environment.",
    ownerHistory: {
      handle: "corewallet-io",
      name: "corewallet",
      age: "11 days",
      established: false,
      repos: 2,
      note: "New account, two repos, both wallet-adjacent.",
    },
    reputation: {
      stars: "680",
      forks: "31",
      sentiment: "A handful of issues report unexpected files and outbound traffic.",
      sentScore: 30,
    },
    stats: { loc: "4,910", packages: 9, stars: "680", created: "12 days ago" },
    packages: [
      { name: "keystore-tools", score: 30, note: "Reads ~/.ssh and shell history on import." },
      { name: "keytar", score: 55, note: "Legit credential lib, used here to enumerate stored secrets." },
      { name: "systeminformation", score: 60, note: "Used to fingerprint the host." },
    ],
    risky: [
      {
        title: "Reads SSH keys on run",
        severity: "high",
        kind: "behavior",
        detail:
          "Sandbox observed reads of ~/.ssh/id_ed25519 and ~/.ssh/known_hosts within 400ms of first execution. No feature here justifies that.",
      },
      {
        title: "Reads shell history",
        severity: "high",
        kind: "behavior",
        detail:
          "Accessed ~/.zsh_history and ~/.bash_history, a common credential-harvesting source.",
      },
      {
        title: "Host fingerprinting",
        severity: "med",
        kind: "behavior",
        detail:
          "Collected hostname, OS, and network interfaces via systeminformation, staged for an outbound call that the locked egress blocked.",
      },
    ],
    logs: [
      {
        ch: "Clone",
        kind: "ok",
        lines: [
          "Resolved corewallet/keystore-tools@2bd7e1",
          "Clone complete · 4,910 lines across 52 files",
        ],
      },
      {
        ch: "Static scan",
        kind: "warn",
        lines: [
          "Semgrep: filesystem reads of ~/.ssh path literals",
          "YARA: matched credential-access heuristic",
          "Confidence to ship: 0.22, escalate",
        ],
      },
      {
        ch: "Reputation",
        kind: "warn",
        lines: ["Account age 11 days · wallet-adjacent repos", "Issues mention unexpected files"],
      },
      {
        ch: "Escalation",
        kind: "bad",
        lines: ["Gate tripped: credential-access pattern", "Sandbox VM provisioned"],
      },
      {
        ch: "Dynamic run",
        kind: "bad",
        lines: [
          "Observed read of ~/.ssh/id_ed25519",
          "Observed read of ~/.zsh_history",
          "Host fingerprint staged · outbound blocked by egress filter",
          "VM reimaged to a clean state",
          "Blended to 44 / 100",
        ],
      },
    ],
  },

  r5: {
    id: "r5",
    owner: "fastlib",
    name: "crypto-utils",
    score: 18,
    verdict: "Malicious",
    cached: false,
    deep: true,
    summary:
      "Presented as a cryptography helper. The code is heavily obfuscated and on execution it began mining and attempted to reach a hardcoded command-and-control host. This is active install-time malware. Do not run.",
    ownerHistory: {
      handle: "fastlib-pkg",
      name: "fastlib",
      age: "2 days",
      established: false,
      repos: 1,
      note: "Brand-new throwaway account, single obfuscated repo.",
    },
    reputation: {
      stars: "94",
      forks: "3",
      sentiment: "No legitimate references; name typosquats a popular package.",
      sentScore: 8,
    },
    stats: { loc: "1,180", packages: 4, stars: "94", created: "2 days ago" },
    packages: [
      { name: "crypto-utils", score: 8, note: "Obfuscated payload, base64 + eval. Miner + C2." },
      { name: "node-fetch", score: 88, note: "Legit lib weaponized for C2 beacon." },
      { name: "worker-farm", score: 40, note: "Spawns workers used for mining." },
    ],
    risky: [
      {
        title: "Obfuscated eval payload",
        severity: "high",
        kind: "code",
        detail:
          "Core module is a single base64 blob passed to eval(). Decoding revealed a miner and a beacon, a hallmark of install-time malware.",
      },
      {
        title: "Crypto-mining on run",
        severity: "high",
        kind: "behavior",
        detail:
          "Sandbox CPU pinned to 100% across worker-farm processes within seconds of execution.",
      },
      {
        title: "C2 beacon attempt",
        severity: "high",
        kind: "behavior",
        detail:
          "Repeated outbound to 185.x.x.x:8443 (hardcoded). Egress filter blocked it; the attempt is the detection.",
      },
      {
        title: "Typosquat name",
        severity: "high",
        kind: "rep",
        detail: "Name closely shadows a popular crypto package to catch fat-finger installs.",
      },
    ],
    logs: [
      {
        ch: "Clone",
        kind: "ok",
        lines: [
          "Resolved fastlib/crypto-utils@9ee0a2",
          "Clone complete · 1,180 lines across 6 files",
        ],
      },
      {
        ch: "Static scan",
        kind: "bad",
        lines: [
          "YARA: obfuscation + eval(base64) match",
          "ClamAV: heuristic miner signature",
          "Confidence to ship: 0.04, escalate",
        ],
      },
      {
        ch: "Reputation",
        kind: "bad",
        lines: [
          "Account age 2 days · typosquat detected",
          "No legitimate community references",
        ],
      },
      {
        ch: "Escalation",
        kind: "bad",
        lines: [
          "Gate tripped: obfuscated payload + miner signature",
          "Sandbox VM provisioned",
        ],
      },
      {
        ch: "Dynamic run",
        kind: "bad",
        lines: [
          "eval() decoded to a miner + beacon",
          "CPU 100% across worker-farm",
          "Outbound to 185.x.x.x:8443 blocked",
          "Repo attacked the sandbox, the attempt is the signal",
          "VM reimaged to a clean state",
          "Blended to 18 / 100",
        ],
      },
    ],
  },
};

/** The public dangerous-repos leaderboard (worst score first). */
export const LEADERBOARD: LeaderboardEntry[] = [
  { owner: "freebux", name: "vbucks-generator", score: 6, reason: "Credential stealer disguised as a game tool", id: null },
  { owner: "devkit", name: "clipboard-sync", score: 9, reason: "Replaces copied crypto addresses in the clipboard", id: null },
  { owner: "npm-helper", name: "postinstall-kit", score: 12, reason: "Self-replicating worm, republishes through victims", id: null },
  { owner: "ledger-connect", name: "wallet-bridge", score: 15, reason: "Drains wallet seed phrases at install time", id: null },
  { owner: "fastlib", name: "crypto-utils", score: 18, reason: "Obfuscated miner and C2 beacon on run", id: "r5" },
  { owner: "talent-hub", name: "frontend-take-home", score: 21, reason: "Fake interview repo; harvests tokens on clone-and-run", id: null },
  { owner: "corewallet", name: "keystore-tools", score: 44, reason: "Reads SSH keys and shell history on first run", id: "r4" },
];

/** Recent-activity ticker on the homepage. */
export const ACTIVITY: ActivityEntry[] = [
  { owner: "verdant", name: "ratchet", score: 96, when: "just now" },
  { owner: "fastlib", name: "crypto-utils", score: 18, when: "12s ago" },
  { owner: "marlow", name: "envguard", score: 88, when: "40s ago" },
  { owner: "quickdev", name: "setup-helper", score: 71, when: "1m ago" },
  { owner: "ana-mirza", name: "pomodoro-cli", score: 94, when: "2m ago" },
  { owner: "devkit", name: "clipboard-sync", score: 9, when: "3m ago" },
];

/** Homepage "use case" cards. */
export const useCases: UseCase[] = [
  { no: "01", title: "Cloning a tutorial", body: "You found a repo on a forum and you are about to npm install. Check it first, in seconds, before it touches your machine." },
  { no: "02", title: "Vetting a dependency", body: "A library looks useful but the owner is unfamiliar. See what it does at install time and whether the account is real." },
  { no: "03", title: "The take-home task", body: "A recruiter sent a repo to clone and run. The oldest trick in the book. We run it in a sandbox so you never have to." },
  { no: "04", title: "Agents that clone and run", body: "Autonomous coding agents pull and execute code with no human watching. A scan is the guardrail before they run." },
];

/**
 * Repo ids shown as one-click suggestion chips under the hero scan box, in
 * order (matches the prototype's `suggestions` array).
 */
export const SUGGESTION_IDS: string[] = ["r1", "r2", "r3", "r5"];

/** Round-robin order the demo cycles through when input does not match a repo. */
export const DEMO_ORDER: string[] = ["r2", "r3", "r4", "r5"];
