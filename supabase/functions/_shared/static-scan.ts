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
  /** Network hosts/IPs seen in install context (for the read prompt). */
  installTimeNetwork: boolean;
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
  { re: /\b(curl|wget)\b[\s\S]{0,80}\bhttps?:\/\//g, label: "shell network fetch" },
];

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

function scanText(
  file: string,
  content: string,
  patterns: Array<{ re: RegExp; label: string }>,
  regions: FlaggedRegion[],
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
        reason: label,
        snippet: snippetAround(content, m.index),
      });
      // Guard against zero-width matches causing an infinite loop.
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }
  return hit;
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
  let installTimeNetwork = false;
  let packageName: string | null = null;

  for (const f of files) {
    const name = basename(f.path);

    if (name === "package.json") {
      const r = analyzePackageJson(f.path, f.content, regions);
      if (r.installHook) signals.installHook = true;
      if (r.networkInScript) installTimeNetwork = true;
      if (r.name && !packageName) packageName = r.name;
    }

    if (name === "setup.py") {
      if (analyzeSetupPy(f.path, f.content, regions)) signals.installHook = true;
    }

    // Shell/install scripts are inherently install-context.
    const isInstallScript = /\.(sh|ps1)$/i.test(name) ||
      /(^|\/)(install|setup|postinstall|bootstrap)\./i.test(f.path);

    if (scanText(f.path, f.content, OBFUSCATION_PATTERNS, regions)) {
      signals.obfuscation = true;
    }
    // Region-only: surface dynamic-code use for the read model to judge in
    // context, but set NO binary signal (no auto-escalation, no score penalty on
    // its own). Legitimate metaprogramming must not read as malware.
    scanText(f.path, f.content, DYNAMIC_CODE_PATTERNS, regions);
    if (scanText(f.path, f.content, CRED_PATH_PATTERNS, regions)) {
      signals.credAccess = true;
    }
    if (scanText(f.path, f.content, SECRET_PATTERNS, regions)) {
      signals.embeddedSecret = true;
    }
    if (scanText(f.path, f.content, NETWORK_PATTERNS, regions)) {
      signals.network = true;
      if (isInstallScript) installTimeNetwork = true;
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

  // Severity hint from code signals only (reputation handled elsewhere).
  let severityHint: StaticScanResult["severityHint"] = "clean";
  if (signals.obfuscation || signals.credAccess || signals.embeddedSecret) {
    severityHint = "high";
  } else if (installTimeNetwork || (signals.installHook && signals.network)) {
    severityHint = "medium";
  } else if (signals.installHook || signals.network || signals.typosquat) {
    severityHint = "low";
  }

  return { flaggedRegions: regions, signals, severityHint, installTimeNetwork };
}
