/**
 * Static scan layer — real heuristic signals over the fetched files.
 *
 * Per the PRD two-speed funnel: cheap static analysis flags the regions the read
 * model then inspects. The model reads ONLY these flagged regions (plus
 * metadata), not the whole repo — that is what keeps the fast path cheap.
 *
 * This module produces REAL signals (no stubs): install hooks, obfuscation,
 * credential/exfil path literals, suspicious network, embedded secrets, and a
 * typosquat hint. Output: flagged regions + a signal summary + a severity hint.
 *
 * These are CODE signals only. Reputation (owner age, stars, sentiment) is
 * handled separately by the orchestrator and never mixed in here.
 */

import type { FetchedFile } from "./github.ts";

/** A region of a file the read model should inspect, with why it was flagged. */
export interface FlaggedRegion {
  file: string;
  reason: string;
  /** A short snippet (capped) showing the matched evidence. */
  snippet: string;
}

export interface StaticSignals {
  installHook: boolean;
  obfuscation: boolean;
  credAccess: boolean;
  network: boolean;
  embeddedSecret: boolean;
  typosquat: boolean;
}

export interface StaticScanResult {
  flaggedRegions: FlaggedRegion[];
  signals: StaticSignals;
  /** Overall code-signal severity hint for the escalation gate. */
  severityHint: "clean" | "low" | "medium" | "high";
  /** Network hosts/IPs seen in install context (for the read prompt). Pre-
   * live-verification value: true if EITHER `installTimeNetworkHard` or
   * `unrecognizedInstallHosts` is non-empty — kept for any caller that
   * doesn't do live host verification. */
  installTimeNetwork: boolean;
  /** installTimeNetwork driven by a reason that must NEVER be downgraded by
   * live host verification: a hardcoded IP literal, an npm/setup.py install
   * hook with network/shell tokens, or a fetch to an unrecognized host in a
   * file that ALSO reads credentials. None of these become legitimate just
   * because the host happens to respond to an HTTP request. */
  installTimeNetworkHard: boolean;
  /** Deduped unrecognized hostnames seen ONLY via a plain provisioning-script
   * fetch (no credential access in that same file, no hardcoded IP) — the
   * caller may live-verify these (a cheap real HTTP check) and, if ALL verify
   * as a normal responding host, downgrade `installTimeNetwork` to false when
   * `installTimeNetworkHard` is also false. See scan/index.ts. */
  unrecognizedInstallHosts: string[];
}

const SNIPPET_MAX = 240;

/** Popular package names used for a lightweight typosquat-distance check. */
const POPULAR_PACKAGES = [
  "react", "lodash", "express", "axios", "chalk", "commander", "request",
  "moment", "webpack", "babel", "typescript", "next", "vue", "jquery",
  "dotenv", "node-fetch", "crypto-js", "bcrypt", "jsonwebtoken", "uuid",
  "colors", "debug", "yargs", "mongoose", "redux", "ethers", "web3",
];

function snippetAround(content: string, index: number): string {
  const start = Math.max(0, index - 60);
  const end = Math.min(content.length, index + 120);
  return content.slice(start, end).replace(/\s+/g, " ").trim().slice(0, SNIPPET_MAX);
}

/** Levenshtein distance (bounded use for short package names). */
function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > 2) return 99;
  const dp = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

// --- Detection patterns ------------------------------------------------------

const INSTALL_HOOK_KEYS = ["preinstall", "install", "postinstall"];

const CRED_PATH_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /~\/\.ssh|\.ssh\/id_(rsa|ed25519|ecdsa)/g, label: "SSH key path access" },
  { re: /id_rsa\b/g, label: "private SSH key reference" },
  { re: /\.aws\/credentials/g, label: "AWS credentials path access" },
  { re: /\.npmrc\b/g, label: ".npmrc (npm auth token) access" },
  { re: /~\/\.(zsh|bash)_history/g, label: "shell history access" },
  { re: /\.config\/gcloud|\.kube\/config/g, label: "cloud config access" },
  { re: /process\.env\b[\s\S]{0,40}(JSON\.stringify|Object\.keys|Object\.entries)/g, label: "bulk environment-variable read" },
];

const NETWORK_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\bhttps?:\/\/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/g, label: "hardcoded IP URL" },
  { re: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d{2,5}\b/g, label: "hardcoded IP:port" },
];

// Shell fetch-and-run, host-CAPTURING (separate from NETWORK_PATTERNS above so
// the matched host can be checked against SOFTWARE_DISTRIBUTION_HOSTS below).
const SHELL_FETCH_RE = /\b(curl|wget)\b[\s\S]{0,80}\bhttps?:\/\/([A-Za-z0-9.-]+)/g;

/**
 * Recognized software-distribution / vendor-install hosts — mirrors the
 * dynamic sandbox's own SOFTWARE_DISTRIBUTION_HOSTS + REGISTRY_HOSTS
 * (sandbox/cloudrun/harness/assemble-forensics.py): a BUILD/PROVISION-time
 * fetch to one of these, with no credential access in the same file, is a
 * supply-chain/provisioning CAUTION, not on its own evidence of an attack.
 * This is the SAME distinction, applied to the static fast path instead of
 * the dynamic phase-aware capture — general to any repo, not specific to any
 * one script or project. A fetch to an unrecognized host, or a file that ALSO
 * shows credential access, keeps full weight regardless of host.
 */
const SOFTWARE_DISTRIBUTION_HOSTS = [
  "github.com", "githubusercontent.com", "sourceforge.net", "gitlab.com", "bitbucket.org",
  "npmjs.org", "pypi.org", "pythonhosted.org", "crates.io", "debian.org", "ubuntu.com",
  "nodejs.org", "yarnpkg.com",
  // Well-known vendor-install endpoints for common infra/dev tooling — the same
  // "named, intended tool, from its own known distribution point" shape as the
  // registry/source hosts above, just extended past package registries.
  "docker.com", "deno.land", "rustup.rs", "python.org", "apache.org",
];

function isRecognizedDistributionHost(host: string): boolean {
  const h = host.toLowerCase();
  // Anchored suffix match (never a loose `includes`) so `evil-github.com` or
  // `github.com.evil.example` cannot spoof a recognized host.
  return SOFTWARE_DISTRIBUTION_HOSTS.some((d) => h === d || h.endsWith("." + d));
}

const SECRET_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /AKIA[0-9A-Z]{16}/g, label: "AWS access key id" },
  { re: /\bgh[pousr]_[A-Za-z0-9]{30,}/g, label: "GitHub token" },
  { re: /\bsk-[A-Za-z0-9]{20,}/g, label: "OpenAI-style secret key" },
  { re: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/g, label: "embedded private key" },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, label: "Slack token" },
];

// HARD obfuscation: an encoded/decoded payload handed to a code-exec primitive,
// or a long escaped blob. These are strong malware tells, so they set the binary
// `obfuscation` signal (which auto-escalates and weighs −42 in the score).
const OBFUSCATION_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\beval\s*\(\s*(atob|Buffer\.from|decodeURIComponent)/g, label: "eval of decoded payload" },
  // `new Function(atob(...))` / `Function(decode(...))` — the Function-constructor
  // twin of eval-of-decoded; a payload decoded straight into a code-exec call.
  { re: /\bFunction\s*\(\s*(atob|Buffer\.from|decodeURIComponent)/g, label: "Function() of a decoded payload" },
  // eval/Function of an encoded LITERAL. Threshold 60 base64 chars (~45 decoded
  // bytes — ample for a real reverse-shell/exfil one-liner). A legit short format
  // string (e.g. morgan's "tokens, req, res") has spaces/commas, so it never
  // reaches 60 *contiguous* base64-charset chars and is not matched here.
  { re: /\b(eval|Function)\s*\(\s*['"`][A-Za-z0-9+/=]{60,}/g, label: "eval/Function of long base64 blob" },
  { re: /atob\s*\([\s\S]{0,40}\)[\s\S]{0,20}eval/g, label: "atob + eval chain" },
  { re: /(\\x[0-9a-fA-F]{2}){12,}/g, label: "long hex-escaped string" },
];

// SOFT dynamic-code: a bare `new Function('…')`. Legitimate libraries (format/
// template compilers such as morgan, lodash, pug) use this constructor heavily,
// so on its own it is NOT obfuscation and must NOT auto-escalate or tank the
// score — that produced false-HIGH-danger verdicts on clean famous repos. We
// still flag the REGION so the read model inspects it in context and can judge
// "metaprogramming vs. hidden payload"; it just sets no binary signal. A
// genuinely obfuscated `Function("<120+ base64>")` is still caught above.
const DYNAMIC_CODE_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\bnew Function\s*\(\s*['"`]/g, label: "dynamic Function constructor (review: metaprogramming vs. hidden payload)" },
  // `new Function(someVar)` — a COMPUTED argument (the payload could have been
  // decoded into the variable at runtime). Region-only so the read model always
  // sees it; the dangerous decoded-inline form is already a HARD signal above.
  { re: /\bnew Function\s*\(\s*[A-Za-z_$]/g, label: "dynamic Function constructor with a computed argument (review: decoded payload?)" },
];

const NETWORK_TOKENS = /\b(fetch|axios|http\.request|https\.request|net\.connect|child_process|execSync|exec\(|spawn\()/;

/** Max flagged regions recorded per pattern per file (avoids snippet explosion
 * while still surfacing repeated dangerous instances to the read model). */
const MAX_MATCHES_PER_PATTERN = 3;

/**
 * Scan `content` for `patterns`, recording a flagged region for each match.
 *
 * Returns whether any pattern matched — the caller uses this to set the binary
 * code SIGNAL — EXCEPT when `docFile` is true. In a documentation/prose file a
 * match is a MENTION of a credential path / secret format / network literal /
 * code-exec primitive, not executable behavior, so it is still surfaced as a
 * region (for the read model and the report), but this returns `false` so it
 * never sets the binary signal that drives the deterministic penalty. The region
 * reason is prefixed to make that distinction explicit in the report. This is the
 * same "region, no binary signal" shape already used for DYNAMIC_CODE_PATTERNS.
 */
function scanText(
  file: string,
  content: string,
  patterns: Array<{ re: RegExp; label: string }>,
  regions: FlaggedRegion[],
  docFile = false,
): boolean {
  let hit = false;
  for (const { re, label } of patterns) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    let count = 0;
    while ((m = re.exec(content)) !== null && count < MAX_MATCHES_PER_PATTERN) {
      hit = true;
      count++;
      regions.push({
        file,
        reason: docFile
          ? `mentioned in documentation/prose — ${label} (not an executable access)`
          : label,
        snippet: snippetAround(content, m.index),
      });
      // Guard against zero-width matches causing an infinite loop.
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }
  // A match inside a documentation/prose file is a MENTION, not a behavior: keep
  // the region for context but never let it set the binary code signal.
  return docFile ? false : hit;
}

function analyzePackageJson(
  file: string,
  content: string,
  regions: FlaggedRegion[],
): { installHook: boolean; name: string | null; networkInScript: boolean } {
  let installHook = false;
  let networkInScript = false;
  let name: string | null = null;
  try {
    const pkg = JSON.parse(content) as {
      name?: string;
      scripts?: Record<string, string>;
    };
    name = pkg.name ?? null;
    const scripts = pkg.scripts ?? {};
    for (const key of INSTALL_HOOK_KEYS) {
      const script = scripts[key];
      if (script) {
        installHook = true;
        const hasNet = NETWORK_TOKENS.test(script) ||
          /\b(curl|wget|node|sh|bash)\b/.test(script);
        if (hasNet) networkInScript = true;
        regions.push({
          file,
          reason: `package.json scripts.${key} present${
            hasNet ? " (runs network/shell at install time)" : ""
          }`,
          snippet: `"${key}": ${JSON.stringify(script).slice(0, SNIPPET_MAX)}`,
        });
      }
    }
  } catch {
    // Malformed package.json — flag it so the model notes it.
    regions.push({
      file,
      reason: "package.json could not be parsed",
      snippet: content.slice(0, SNIPPET_MAX),
    });
  }
  return { installHook, name, networkInScript };
}

function analyzeSetupPy(
  file: string,
  content: string,
  regions: FlaggedRegion[],
): boolean {
  let hook = false;
  const patterns: Array<{ re: RegExp; label: string }> = [
    { re: /os\.system\s*\(/g, label: "setup.py os.system() call" },
    { re: /subprocess\.(run|call|Popen|check_output)\s*\(/g, label: "setup.py subprocess call" },
    { re: /cmdclass\s*=|class\s+\w*Install\w*\(/g, label: "setup.py custom install command" },
    { re: /__import__\s*\(|exec\s*\(/g, label: "setup.py dynamic exec/import" },
  ];
  for (const { re, label } of patterns) {
    re.lastIndex = 0;
    const m = re.exec(content);
    if (m) {
      hook = true;
      regions.push({ file, reason: label, snippet: snippetAround(content, m.index) });
    }
  }
  return hook;
}

function checkTyposquat(packageName: string | null): { hit: boolean; near?: string } {
  if (!packageName) return { hit: false };
  const bare = packageName.replace(/^@[^/]+\//, "").toLowerCase();
  if (POPULAR_PACKAGES.includes(bare)) return { hit: false }; // exact = the real one
  for (const popular of POPULAR_PACKAGES) {
    const d = editDistance(bare, popular);
    if (d >= 1 && d <= 2) return { hit: true, near: popular };
  }
  return { hit: false };
}

function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

/**
 * Documentation / prose files whose CONTENT is text ABOUT code, not executable
 * code. This is the doc-vs-code distinction that prevents a false "credential
 * access" (or embedded-secret / network / obfuscation) signal firing merely
 * because a README, changelog, or guide MENTIONS a credential-shaped path,
 * command, or key format in prose.
 *
 * WHY THIS EXISTS: the content patterns below (credential paths, secret formats,
 * network literals, obfuscation primitives) are byte-level regexes. In a source
 * file a `.npmrc` / `~/.ssh/id_rsa` literal is (near-always) part of code that
 * READS that path at runtime — a real behavior. In a README the SAME literal is
 * almost always documentation: "put your auth token in `.npmrc`", "we never read
 * `~/.ssh`", an example config, or a security note. A prose MENTION is not a
 * runtime access, and scoring a Google-owned, 24k-star docs repo as "Dangerous"
 * (-40) because its README describes `.npmrc` registry configuration is exactly
 * the false-"Dangerous" this product cannot afford — as damaging to trust as a
 * false "Safe".
 *
 * We do NOT drop these matches silently: a match in a doc file is still surfaced
 * as a flagged REGION (so the read model inspects it and the report can cite it),
 * it simply does NOT set the binary code SIGNAL that drives the deterministic
 * penalty. This mirrors the existing `DYNAMIC_CODE_PATTERNS` treatment (region,
 * no binary signal) already used for legitimate `new Function('…')`.
 *
 * This is precise, not lax: an executable source file that genuinely reads a
 * credential path, embeds a live key, or hides an eval-of-decoded payload still
 * trips the full-severity signal, because those files are not documentation.
 */
const DOC_EXTENSIONS = new Set([
  "md", "markdown", "mdx", "mdown", "mkd",
  "rst", "txt", "text", "adoc", "asciidoc",
]);

/** Base filenames that are prose/legal even without one of the doc extensions. */
const DOC_BASENAMES = new Set([
  "readme", "license", "licence", "notice", "changelog", "changes",
  "contributing", "authors", "copying", "code_of_conduct", "security",
  "codeowners",
]);

/**
 * True when a file's CONTENT is prose/documentation about code rather than
 * executable source. Matches by extension, by well-known base name (with or
 * without extension), or by living under a docs/-style directory.
 */
function isDocumentationFile(path: string): boolean {
  const lowerPath = path.toLowerCase();
  const name = basename(lowerPath);

  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1) : "";
  if (ext && DOC_EXTENSIONS.has(ext)) return true;

  // Base name without extension (e.g. "README", "LICENSE", "README.foo").
  const stem = dot > 0 ? name.slice(0, dot) : name;
  if (DOC_BASENAMES.has(stem)) return true;
  // Extensionless well-known files (e.g. a bare "LICENSE" or "NOTICE").
  if (!ext && DOC_BASENAMES.has(name)) return true;

  // Files that live in a documentation directory are prose regardless of ext,
  // e.g. `docs/setup.txt`, `documentation/config`, `doc/guide`. Anchored to a
  // path segment so it never matches a substring like `src/adoctor.js`.
  if (/(^|\/)(docs?|documentation)\//.test(lowerPath)) return true;

  return false;
}

/** Run the static scan over the fetched files. Pure, no I/O. */
export function staticScan(files: FetchedFile[]): StaticScanResult {
  const regions: FlaggedRegion[] = [];
  const signals: StaticSignals = {
    installHook: false,
    obfuscation: false,
    credAccess: false,
    network: false,
    embeddedSecret: false,
    typosquat: false,
  };
  let installTimeNetworkHard = false;
  const unrecognizedInstallHosts = new Set<string>();
  let packageName: string | null = null;

  for (const f of files) {
    const name = basename(f.path);

    if (name === "package.json") {
      const r = analyzePackageJson(f.path, f.content, regions);
      if (r.installHook) signals.installHook = true;
      // An npm lifecycle hook (preinstall/install/postinstall) running network/
      // shell code is the core real supply-chain attack vector — it fires
      // automatically on `npm install`, unlike a standalone provisioning
      // script a human must run deliberately. Always full weight; no host to
      // even check here (the heuristic is token-based, not host-extracted).
      if (r.networkInScript) installTimeNetworkHard = true;
      if (r.name && !packageName) packageName = r.name;
    }

    if (name === "setup.py") {
      if (analyzeSetupPy(f.path, f.content, regions)) signals.installHook = true;
    }

    // Shell/install scripts are inherently install-context.
    const isInstallScript = /\.(sh|ps1)$/i.test(name) ||
      /(^|\/)(install|setup|postinstall|bootstrap)\./i.test(f.path);

    // Documentation/prose files (README, LICENSE, *.md, docs/…) contain text
    // ABOUT code, not executable code. A credential-path / secret / network /
    // obfuscation literal in prose is a MENTION, not a runtime behavior, so the
    // content patterns below surface a region for the read model but must NOT set
    // the binary code signals that drive the deterministic penalties. Without
    // this, a README merely describing `.npmrc` registry config trips a -40
    // credential-access penalty — a product-breaking false "Dangerous".
    const isDocFile = isDocumentationFile(f.path);

    if (scanText(f.path, f.content, OBFUSCATION_PATTERNS, regions, isDocFile)) {
      signals.obfuscation = true;
    }
    // Region-only: surface dynamic-code use for the read model to judge in
    // context, but set NO binary signal (no auto-escalation, no score penalty on
    // its own). Legitimate metaprogramming must not read as malware.
    scanText(f.path, f.content, DYNAMIC_CODE_PATTERNS, regions, isDocFile);
    const credInThisFile = scanText(f.path, f.content, CRED_PATH_PATTERNS, regions, isDocFile);
    if (credInThisFile) {
      signals.credAccess = true;
    }
    if (scanText(f.path, f.content, SECRET_PATTERNS, regions, isDocFile)) {
      signals.embeddedSecret = true;
    }
    if (scanText(f.path, f.content, NETWORK_PATTERNS, regions, isDocFile)) {
      // Hardcoded IP literals are never a "recognized software-distribution
      // host" shape — always full weight in an install/provisioning script,
      // never eligible for live-host-verification downgrade.
      signals.network = true;
      if (isInstallScript) installTimeNetworkHard = true;
    }

    // Shell fetch-and-run (curl|wget ... https://host/...), HOST-AWARE: a
    // PROVISIONING-context fetch to a recognized software-distribution/vendor
    // host, with no credential access in this SAME file, is a supply-chain
    // caution — surfaced as a region, but does not on its own set the hard
    // `installTimeNetwork` escalation trigger. A fetch to an unrecognized
    // host, or a file that also reads credentials, keeps FULL weight — this
    // narrows ONE specific false-positive (legitimate infra-provisioning
    // scripts fetching a named, intended tool from its own known
    // distribution point) and does not soften a real install-time attack.
    SHELL_FETCH_RE.lastIndex = 0;
    let fetchMatch: RegExpExecArray | null;
    let fetchCount = 0;
    const unrecognizedHostsThisFile = new Set<string>();
    let sawAnyFetch = false;
    while (
      (fetchMatch = SHELL_FETCH_RE.exec(f.content)) !== null &&
      fetchCount < MAX_MATCHES_PER_PATTERN
    ) {
      sawAnyFetch = true;
      fetchCount++;
      const host = fetchMatch[2];
      const recognized = isRecognizedDistributionHost(host);
      if (!recognized) unrecognizedHostsThisFile.add(host);
      regions.push({
        file: f.path,
        reason: isDocFile
          ? "mentioned in documentation/prose — shell network fetch (not an executable access)"
          : recognized
          ? `provisioning fetch to a recognized software-distribution host (${host}) — supply-chain caution, not a confirmed attack on its own`
          : `shell network fetch to an unrecognized host (${host}) — pending live verification`,
        snippet: snippetAround(f.content, fetchMatch.index),
      });
      if (fetchMatch.index === SHELL_FETCH_RE.lastIndex) SHELL_FETCH_RE.lastIndex++;
    }
    if (sawAnyFetch && !isDocFile) {
      signals.network = true;
      if (isInstallScript) {
        if (credInThisFile) {
          // Credential access anywhere in a file that also fetches (whether
          // the fetch is to a recognized or unrecognized host) keeps full
          // weight — never eligible for a live-verification downgrade.
          installTimeNetworkHard = true;
        } else if (unrecognizedHostsThisFile.size > 0) {
          for (const h of unrecognizedHostsThisFile) unrecognizedInstallHosts.add(h);
        }
      }
    }
  }

  const typo = checkTyposquat(packageName);
  if (typo.hit) {
    signals.typosquat = true;
    regions.push({
      file: "package.json",
      reason: `package name "${packageName}" closely shadows popular package "${typo.near}" (typosquat hint)`,
      snippet: `name: ${packageName}`,
    });
  }

  // Pre-live-verification value — true if EITHER sub-reason fired. A caller
  // doing live host verification should use `installTimeNetworkHard` and
  // `unrecognizedInstallHosts` directly instead (see scan/index.ts).
  const installTimeNetwork = installTimeNetworkHard || unrecognizedInstallHosts.size > 0;
  const severityHint = computeSeverityHint(signals, installTimeNetwork);

  return {
    flaggedRegions: regions,
    signals,
    severityHint,
    installTimeNetwork,
    installTimeNetworkHard,
    unrecognizedInstallHosts: Array.from(unrecognizedInstallHosts),
  };
}

/**
 * Severity hint from code signals only (reputation handled elsewhere).
 * Exported so a caller that live-verifies `unrecognizedInstallHosts` (see
 * scan/index.ts) can recompute this against the POST-verification
 * `installTimeNetwork` value rather than leaving it stale.
 */
export function computeSeverityHint(
  signals: StaticSignals,
  installTimeNetwork: boolean,
): StaticScanResult["severityHint"] {
  if (signals.obfuscation || signals.credAccess || signals.embeddedSecret) {
    return "high";
  }
  if (installTimeNetwork || (signals.installHook && signals.network)) {
    return "medium";
  }
  if (signals.installHook || signals.network || signals.typosquat) {
    return "low";
  }
  return "clean";
}
