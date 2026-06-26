/**
 * Cached real-repo scans — the homepage / dashboard showcase set.
 *
 * Every report below is a REAL response from the live `scan` edge function
 * (POST /functions/v1/scan), captured verbatim from a famous public GitHub
 * repository across multiple owners (chalk, expressjs, pallets, psf, tj,
 * gorilla, sindresorhus). Scores, summaries, owner history, reputation, risky
 * findings, and scan logs are exactly what the scanner returned — nothing here
 * is invented, personas-as-data, or hand-authored fixtures.
 *
 * Per CLAUDE.md these stand in for the live DB cache until the public report
 * surface reads from Supabase directly: the SPA falls back to these by id when
 * a report is not in its in-session live cache, so the showcase reflects real
 * verdicts on real, recognizable code rather than fabricated examples.
 *
 * The `LEADERBOARD` (dangerous-repos board) is intentionally EMPTY: famous
 * repos all score safe, and we will not invent malware personas to fill it. It
 * populates from real low-scoring scans in the live DB over time.
 */

import type {
  ActivityEntry,
  LeaderboardEntry,
  Report,
  UseCase,
} from "./types";

/**
 * Cached real-repo reports, keyed by "owner/name" id (the same id the live
 * scan path uses, so the SPA's live cache and this set share a keyspace).
 * Each entry is a verbatim live-scan result.
 */
export const REPOS: Record<string, Report> = {
  "expressjs/express": {
    id: "expressjs/express",
    owner: "expressjs",
    name: "express",
    score: 98,
    verdict: "Trusted",
    cached: true,
    deep: false,
    summary:
      "Express.js is a foundational, industry-standard web framework for Node.js. The static analysis of the provided files revealed no malicious patterns, obfuscation, or suspicious network activity. While this repository is highly trusted, please note that this assessment is based on a static read of the provided files; full runtime behavior was not executed in a sandbox on this pass.",
    ownerHistory: {
      handle: "expressjs",
      name: "Express.js Organization",
      age: "12 yr 8 mo",
      established: true,
      repos: 49,
      note: "Highly established organization with a long history of maintaining critical infrastructure.",
    },
    reputation: {
      stars: "69242",
      forks: "23860",
      sentiment: "Extremely positive, industry standard",
      sentScore: 100,
    },
    stats: { loc: "9880 KB", packages: 0, stars: "69242", created: "12 yr 8 mo ago" },
    packages: [],
    risky: [],
    logs: [
      {
        ch: "Clone",
        kind: "ok",
        lines: ["Cloned repository expressjs/express at commit 18e5985b8a9d5e8423db0a9121f22bdaecd5b120"],
      },
      {
        ch: "Static scan",
        kind: "ok",
        lines: ["Scanned 15 files for malicious patterns", "No flagged regions or suspicious code found"],
      },
      {
        ch: "Reputation",
        kind: "ok",
        lines: [
          "Owner expressjs is a well-established organization",
          "Repository has significant community backing (69k+ stars)",
        ],
      },
      {
        ch: "Read",
        kind: "ok",
        lines: [
          "Code structure consistent with standard Express.js framework patterns",
          "No obfuscation or hidden network calls detected",
        ],
      },
    ],
  },

  "pallets/flask": {
    id: "pallets/flask",
    owner: "pallets",
    name: "flask",
    score: 98,
    verdict: "Trusted",
    cached: true,
    deep: false,
    summary:
      "Flask is a highly established, industry-standard Python web framework maintained by the Pallets organization. The static scan identified hardcoded local loopback addresses (127.0.0.1) in documentation examples, which are standard for local development instructions and pose no security risk. No malicious behavior was observed in our static read; full runtime behavior was not executed in a sandbox on this pass.",
    ownerHistory: {
      handle: "pallets",
      name: "Pallets",
      age: "10 yr 5 mo",
      established: true,
      repos: 17,
      note: "Highly established organization with a long history of maintaining critical open-source infrastructure.",
    },
    reputation: {
      stars: "71734",
      forks: "16876",
      sentiment: "Excellent",
      sentScore: 100,
    },
    stats: { loc: "12008 KB", packages: 0, stars: "71734", created: "10 yr 5 mo" },
    packages: [],
    risky: [
      {
        title: "Hardcoded local loopback address in documentation",
        severity: "low",
        kind: "code",
        detail:
          "Documentation examples reference 127.0.0.1:5000 for local development testing, which is standard practice and not a security vulnerability.",
      },
    ],
    logs: [
      {
        ch: "Clone",
        kind: "ok",
        lines: ["Cloned repository pallets/flask at commit 36e4a824f340fdee7ed50937ba8e7f6bc7d17f81"],
      },
      {
        ch: "Reputation",
        kind: "ok",
        lines: [
          "Owner 'pallets' is a well-known, established entity in the Python ecosystem.",
          "High star count and long account history indicate high trust.",
        ],
      },
      {
        ch: "Static scan",
        kind: "ok",
        lines: [
          "No malicious patterns, obfuscation, or unauthorized network calls detected.",
          "Flagged regions identified as standard documentation for local development.",
        ],
      },
      {
        ch: "Read",
        kind: "ok",
        lines: [
          "Analyzed 15 files including READMEs and examples.",
          "All flagged items are benign references to localhost.",
        ],
      },
    ],
  },

  "psf/requests": {
    id: "psf/requests",
    owner: "psf",
    name: "requests",
    score: 98,
    verdict: "Trusted",
    cached: true,
    deep: false,
    summary:
      "The repository is a highly reputable, industry-standard Python library maintained by the Python Software Foundation. Static analysis identified hardcoded local loopback addresses (127.0.0.1) within test files, which are standard practice for verifying network adapter behavior in isolation. No malicious behavior was observed in our static read; full runtime behavior was not executed in a sandbox on this pass.",
    ownerHistory: {
      handle: "psf",
      name: "Python Software Foundation",
      age: "7 yr 1 mo",
      established: true,
      repos: 42,
      note: "Extremely high trust level as the official organization for Python.",
    },
    reputation: {
      stars: "54070",
      forks: "9988",
      sentiment: "Excellent",
      sentScore: 100,
    },
    stats: { loc: "13555 KB", packages: 0, stars: "54070", created: "2599 days ago" },
    packages: [],
    risky: [
      {
        title: "Hardcoded loopback address in tests",
        severity: "low",
        kind: "code",
        detail:
          "Test suite contains references to 127.0.0.1:10000 for local adapter verification; this is expected behavior for testing network libraries.",
      },
      {
        title: "High-reputation organization",
        severity: "low",
        kind: "rep",
        detail:
          "Maintained by the Python Software Foundation, a highly established and trusted entity.",
      },
    ],
    logs: [
      {
        ch: "Clone",
        kind: "ok",
        lines: ["Cloned repository psf/requests at commit 4ed3d1b3204caa6806a36125a39589044a02e807"],
      },
      {
        ch: "Static scan",
        kind: "ok",
        lines: ["Scanning 15 files for malicious patterns", "No obfuscation or embedded secrets detected"],
      },
      {
        ch: "Reputation",
        kind: "ok",
        lines: [
          "Owner verified as Python Software Foundation",
          "High star count and long account history confirmed",
        ],
      },
      {
        ch: "Read",
        kind: "warn",
        lines: [
          "Identified hardcoded 127.0.0.1 addresses in tests/test_adapters.py",
          "Verified these are used for local test assertions",
        ],
      },
    ],
  },

  "chalk/chalk": {
    id: "chalk/chalk",
    owner: "chalk",
    name: "chalk",
    score: 98,
    verdict: "Trusted",
    cached: true,
    deep: false,
    summary:
      "The repository is a highly established, widely used utility with no suspicious code patterns detected. While no malicious behavior was observed in our static read, full runtime behavior was not executed in a sandbox on this pass.",
    ownerHistory: {
      handle: "chalk",
      name: "chalk",
      age: "10 yr 12 mo",
      established: true,
      repos: 16,
      note: "Highly established organization with a long history of maintaining popular open-source tooling.",
    },
    reputation: {
      stars: "23262",
      forks: "1002",
      sentiment: "Extremely positive community standing",
      sentScore: 100,
    },
    stats: { loc: "1067 KB", packages: 0, stars: "23262", created: "10 yr 12 mo" },
    packages: [],
    risky: [],
    logs: [
      {
        ch: "Clone",
        kind: "ok",
        lines: [
          "Repository chalk/chalk cloned successfully.",
          "Commit hash verified: aa06bb5ac3f14df9fda8cfb54274dfc165ddfdef.",
        ],
      },
      {
        ch: "Static scan",
        kind: "ok",
        lines: ["No suspicious patterns, obfuscation, or network calls detected in the 15 files scanned."],
      },
      {
        ch: "Reputation",
        kind: "ok",
        lines: [
          "Owner is an established organization with 10+ years of history.",
          "High star count and community adoption indicate a trusted source.",
        ],
      },
      {
        ch: "Read",
        kind: "ok",
        lines: ["Code structure is clean and consistent with terminal styling utilities."],
      },
    ],
  },

  "tj/commander.js": {
    id: "tj/commander.js",
    owner: "tj",
    name: "commander.js",
    score: 98,
    verdict: "Trusted",
    cached: true,
    deep: false,
    summary:
      "Commander.js is a widely used, highly established library for building CLI tools in Node.js. The static analysis of the codebase revealed no suspicious patterns, obfuscation, or unauthorized network activity. While this scan confirms the absence of malicious static indicators, it does not constitute a full runtime execution or sandbox analysis of the library's behavior in a production environment.",
    ownerHistory: {
      handle: "tj",
      name: "TJ",
      age: "17 yr 9 mo",
      established: true,
      repos: 296,
      note: "The owner is a highly reputable and long-standing member of the Node.js ecosystem.",
    },
    reputation: {
      stars: "28288",
      forks: "1757",
      sentiment: "Extremely positive",
      sentScore: 100,
    },
    stats: { loc: "3875 KB", packages: 0, stars: "28288", created: "17 yr 9 mo" },
    packages: [],
    risky: [],
    logs: [
      {
        ch: "Clone",
        kind: "ok",
        lines: ["Cloned repository tj/commander.js at commit ba6d13d", "Repository metadata verified"],
      },
      {
        ch: "Static scan",
        kind: "ok",
        lines: ["No flagged regions detected", "No install hooks or obfuscated code found"],
      },
      {
        ch: "Reputation",
        kind: "ok",
        lines: [
          "Owner 'tj' is highly established with 17+ years of history",
          "High community trust and significant star count",
        ],
      },
      {
        ch: "Read",
        kind: "ok",
        lines: [
          "Codebase structure is consistent with standard Node.js library practices",
          "No malicious behavior observed in our static read; full runtime behavior was not executed in a sandbox on this pass",
        ],
      },
    ],
  },

  "gorilla/mux": {
    id: "gorilla/mux",
    owner: "gorilla",
    name: "mux",
    score: 95,
    verdict: "Trusted",
    cached: true,
    deep: false,
    summary:
      "gorilla/mux is a widely recognized, long-standing Go routing library. The static analysis identified hardcoded IP/port combinations in documentation and examples, which are standard for demonstrating server setup and do not represent malicious behavior. No malicious behavior was observed in our static read; full runtime behavior was not executed in a sandbox on this pass.",
    ownerHistory: {
      handle: "gorilla",
      name: "Gorilla web toolkit",
      age: "15 yr 7 mo",
      established: true,
      repos: 19,
      note: "Highly reputable organization in the Go ecosystem.",
    },
    reputation: {
      stars: "21839",
      forks: "1884",
      sentiment: "Excellent",
      sentScore: 100,
    },
    stats: { loc: "543 KB", packages: 1, stars: "21839", created: "15 yr 7 mo" },
    packages: [
      {
        name: "gorilla/mux",
        score: 95,
        note: "Standard HTTP router for Go; highly established and widely used.",
      },
    ],
    risky: [
      {
        title: "Hardcoded IP/Port in documentation",
        severity: "low",
        kind: "code",
        detail:
          "Examples in README.md and doc.go contain hardcoded local addresses (127.0.0.1:8000, 0.0.0.0:8080) for demonstration purposes.",
      },
      {
        title: "Established Organization",
        severity: "low",
        kind: "rep",
        detail:
          "The repository is maintained by the Gorilla web toolkit organization, which has a 15-year history and high community trust.",
      },
    ],
    logs: [
      {
        ch: "Clone",
        kind: "ok",
        lines: ["Cloned repository gorilla/mux at commit db9d1d0073d27a0a2d9a8c1bc52aa0af4374d265"],
      },
      {
        ch: "Static scan",
        kind: "ok",
        lines: [
          "Scanned 15 files for malicious patterns.",
          "No obfuscation, credential access, or install-time network activity detected.",
        ],
      },
      {
        ch: "Reputation",
        kind: "ok",
        lines: [
          "Owner 'gorilla' is a well-established organization with 15+ years of history.",
          "High star count (21839) indicates significant community adoption.",
        ],
      },
      {
        ch: "Read",
        kind: "warn",
        lines: [
          "Identified hardcoded IP/port snippets in documentation files (README.md, doc.go).",
          "Confirmed these are standard example configurations for local server binding.",
        ],
      },
    ],
  },

  "sindresorhus/is": {
    id: "sindresorhus/is",
    owner: "sindresorhus",
    name: "is",
    score: 98,
    verdict: "Trusted",
    cached: true,
    deep: false,
    summary:
      "The repository 'sindresorhus/is' is a highly reputable utility library for type checking. Static analysis revealed no suspicious patterns, obfuscation, or unauthorized network activity. While no malicious behavior was observed in our static read, full runtime behavior was not executed in a sandbox on this pass.",
    ownerHistory: {
      handle: "sindresorhus",
      name: "Sindre Sorhus",
      age: "16 yr 6 mo",
      established: true,
      repos: 1134,
      note: "Highly prolific and trusted maintainer in the open-source ecosystem.",
    },
    reputation: {
      stars: "1784",
      forks: "129",
      sentiment: "Excellent",
      sentScore: 100,
    },
    stats: { loc: "1238 KB", packages: 0, stars: "1784", created: "16 yr 6 mo ago" },
    packages: [],
    risky: [],
    logs: [
      {
        ch: "Clone",
        kind: "ok",
        lines: ["Cloned repository sindresorhus/is at commit 7821031c66cdeb7256a0feb2d506535f9e84fcaf"],
      },
      {
        ch: "Static scan",
        kind: "ok",
        lines: [
          "No flagged regions identified in the codebase.",
          "No install hooks or network-related code detected.",
        ],
      },
      {
        ch: "Reputation",
        kind: "ok",
        lines: ["Owner is a long-standing, established contributor with over 1000 public repositories."],
      },
      {
        ch: "Read",
        kind: "ok",
        lines: [
          "Codebase appears to be a standard TypeScript utility library.",
          "No malicious behavior observed in our static read; full runtime behavior was not executed in a sandbox on this pass.",
        ],
      },
    ],
  },

  "chalk/supports-color": {
    id: "chalk/supports-color",
    owner: "chalk",
    name: "supports-color",
    score: 98,
    verdict: "Trusted",
    cached: true,
    deep: false,
    summary:
      "The repository 'chalk/supports-color' is a well-established, widely used utility with no malicious indicators found in the static analysis. While no malicious behavior was observed in our static read, full runtime behavior was not executed in a sandbox on this pass.",
    ownerHistory: {
      handle: "chalk",
      name: "chalk",
      age: "10 yr 12 mo",
      established: true,
      repos: 16,
      note: "Highly established organization with a long-standing history in the JavaScript ecosystem.",
    },
    reputation: {
      stars: "370",
      forks: "92",
      sentiment: "Positive",
      sentScore: 95,
    },
    stats: { loc: "132 KB", packages: 0, stars: "370", created: "10 yr 12 mo" },
    packages: [],
    risky: [],
    logs: [
      {
        ch: "Clone",
        kind: "ok",
        lines: ["Cloned repository chalk/supports-color at commit 47d3c56c15368ca0d892fb0e5ebed68afcc08e35"],
      },
      {
        ch: "Static scan",
        kind: "ok",
        lines: [
          "No flagged regions detected in 8 files scanned.",
          "No obfuscation, network calls, or credential access patterns identified.",
        ],
      },
      {
        ch: "Reputation",
        kind: "ok",
        lines: [
          "Owner 'chalk' is an established organization with 10+ years of history.",
          "High community trust and consistent maintenance.",
        ],
      },
      {
        ch: "Read",
        kind: "ok",
        lines: [
          "Code review confirms standard terminal detection logic.",
          "No install-time scripts or suspicious lifecycle hooks found.",
        ],
      },
    ],
  },
};

/**
 * The public dangerous-repos leaderboard (worst score first).
 *
 * Intentionally EMPTY. The board only lists repos the sandbox actually ran and
 * caught scoring low, and we will not invent malware personas to populate it.
 * Every real famous-repo scan above scores safe, so there is nothing honest to
 * put here yet — the board renders empty until real low-scoring scans land in
 * the live DB, at which point it populates from `v_leaderboard`. Kept as a
 * typed `[]` (not removed) because `state.tsx` imports it and renders an honest
 * empty board from it.
 */
export const LEADERBOARD: LeaderboardEntry[] = [];

/**
 * Recent-activity ticker on the homepage. Each entry mirrors a real cached
 * scan above (same owner/name/score), so the "scanning live" strip shows real
 * repos and real verdicts. `when` is a relative label for the ticker ordering.
 */
export const ACTIVITY: ActivityEntry[] = [
  { owner: "expressjs", name: "express", score: 98, when: "just now" },
  { owner: "pallets", name: "flask", score: 98, when: "18s ago" },
  { owner: "psf", name: "requests", score: 98, when: "44s ago" },
  { owner: "gorilla", name: "mux", score: 95, when: "1m ago" },
  { owner: "chalk", name: "chalk", score: 98, when: "2m ago" },
  { owner: "tj", name: "commander.js", score: 98, when: "3m ago" },
];

/** Homepage "use case" cards — honest product copy (what the tool is for). */
export const useCases: UseCase[] = [
  { no: "01", title: "Cloning a tutorial", body: "You found a repo on a forum and you are about to npm install. Check it first, in seconds, before it touches your machine." },
  { no: "02", title: "Vetting a dependency", body: "A library looks useful but the owner is unfamiliar. See what it does at install time and whether the account is real." },
  { no: "03", title: "The take-home task", body: "A recruiter sent a repo to clone and run. The oldest trick in the book. We run it in a sandbox so you never have to." },
  { no: "04", title: "Agents that clone and run", body: "Autonomous coding agents pull and execute code with no human watching. A scan is the guardrail before they run." },
];

/**
 * Repo ids shown as one-click suggestion chips under the hero scan box, in
 * order. Real, recognizable repos across ecosystems (Node, Python, Go).
 */
export const SUGGESTION_IDS: string[] = [
  "expressjs/express",
  "pallets/flask",
  "chalk/chalk",
  "gorilla/mux",
];

/**
 * Order the dashboard / showcase cycles through. Real cached repos across
 * multiple owners and ecosystems.
 */
export const DEMO_ORDER: string[] = [
  "psf/requests",
  "tj/commander.js",
  "sindresorhus/is",
  "chalk/supports-color",
];
