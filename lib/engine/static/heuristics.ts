/**
 * In-process static heuristics (ported from the pre-2.0 regex layer,
 * `supabase/functions/_shared/static-scan.ts`).
 *
 * Output is a flat list of findings with file and line. This module does not
 * decide whether a file matters: the reachability graph tags every finding and
 * the score counts only reachable ones (DESIGN.md section 5.2). The pre-2.0 doc
 * and fixture downgrades are therefore gone; a README or a tests/ file is simply
 * unreachable.
 *
 * Also reports per-file capabilities (network, process spawn, filesystem write)
 * used by the doc-versus-code check.
 */

import { textOf } from "../archive";
import type { Severity, StaticFinding } from "../types";

export type Capability = "network" | "process" | "fs_write";

export interface HeuristicResult {
  findings: StaticFinding[];
  capabilities: Array<{ file: string; capability: Capability }>;
  /** Files skipped because they were binary or over the size cap. */
  skipped: number;
}

const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_MATCHES_PER_RULE_PER_FILE = 3;
const SNIPPET_MAX = 240;

interface Rule {
  id: string;
  re: RegExp;
  severity: Severity;
  message: string;
}

const OBFUSCATION: Rule[] = [
  { id: "heur.obfuscation.eval_decoded", re: /\beval\s*\(\s*(?:atob|Buffer\.from|decodeURIComponent)/g, severity: "high", message: "eval of a decoded payload" },
  { id: "heur.obfuscation.function_decoded", re: /\bFunction\s*\(\s*(?:atob|Buffer\.from|decodeURIComponent)/g, severity: "high", message: "Function() of a decoded payload" },
  { id: "heur.obfuscation.exec_base64_literal", re: /\b(?:eval|Function)\s*\(\s*['"`][A-Za-z0-9+/=]{60,}/g, severity: "high", message: "eval/Function of a long base64 literal" },
  { id: "heur.obfuscation.atob_eval", re: /atob\s*\([\s\S]{0,40}\)[\s\S]{0,20}eval/g, severity: "high", message: "atob + eval chain" },
  { id: "heur.obfuscation.hex_escapes", re: /(?:\\x[0-9a-fA-F]{2}){12,}/g, severity: "high", message: "long hex-escaped string" },
  { id: "heur.obfuscation.py_exec_decoded", re: /\bexec\s*\(\s*(?:base64\.b64decode|codecs\.decode|zlib\.decompress|bytes\.fromhex)/g, severity: "high", message: "Python exec of a decoded payload" },
];

const DYNAMIC_CODE: Rule[] = [
  { id: "heur.dynamic_function", re: /\bnew Function\s*\(\s*['"`A-Za-z_$]/g, severity: "low", message: "dynamic Function constructor (metaprogramming or hidden payload)" },
];

const SECRETS: Rule[] = [
  { id: "heur.secret.aws_key_id", re: /AKIA[0-9A-Z]{16}/g, severity: "medium", message: "embedded AWS access key id" },
  { id: "heur.secret.github_token", re: /\bgh[pousr]_[A-Za-z0-9]{30,}/g, severity: "medium", message: "embedded GitHub token" },
  { id: "heur.secret.sk_key", re: /\bsk-[A-Za-z0-9]{20,}/g, severity: "medium", message: "embedded sk- style secret key" },
  { id: "heur.secret.private_key", re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, severity: "medium", message: "embedded private key" },
  { id: "heur.secret.slack_token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, severity: "medium", message: "embedded Slack token" },
];

const CREDENTIAL_PATHS: Rule[] = [
  { id: "heur.cred.ssh_key", re: /~\/\.ssh|\.ssh\/id_(?:rsa|ed25519|ecdsa)|\bid_rsa\b/g, severity: "high", message: "SSH private key path access" },
  { id: "heur.cred.aws_credentials", re: /\.aws\/credentials/g, severity: "high", message: "AWS credentials path access" },
  { id: "heur.cred.shell_history", re: /~\/\.(?:zsh|bash)_history|\.(?:zsh|bash)_history\b/g, severity: "high", message: "shell history access" },
  { id: "heur.cred.cloud_config", re: /\.config\/gcloud|\.kube\/config|\.docker\/config\.json|\.config\/gh\/hosts\.yml|\.git-credentials/g, severity: "high", message: "cloud or VCS credential file access" },
  { id: "heur.cred.npmrc", re: /\.npmrc\b/g, severity: "medium", message: ".npmrc (registry auth token) access" },
  { id: "heur.cred.bulk_env", re: /process\.env\b[\s\S]{0,40}(?:JSON\.stringify|Object\.keys|Object\.entries)|(?:JSON\.stringify|Object\.entries|Object\.keys)\s*\(\s*process\.env\s*\)|dict\s*\(\s*os\.environ\s*\)/g, severity: "medium", message: "bulk environment variable read" },
];

const CAPABILITY_PATTERNS: Array<{ capability: Capability; re: RegExp }> = [
  {
    capability: "network",
    re: /\bfetch\s*\(|\b(?:https?|net|tls|dgram|dns)\.(?:request|get|connect|createConnection|lookup|resolve)\s*\(|require\s*\(\s*['"](?:node:)?(?:https?|net|tls|dgram)['"]\s*\)|from\s+['"](?:node:)?(?:https?|net|tls|dgram)['"]|\baxios\b|\bXMLHttpRequest\b|\bWebSocket\s*\(|\burllib\.request|\brequests\.(?:get|post|put|request)|\bsocket\.socket\s*\(|\bhttp\.client\b|\burlopen\s*\(/g,
  },
  { capability: "process", re: /\bchild_process\b|\bexecSync\s*\(|\bspawnSync?\s*\(|\bsubprocess\.(?:run|call|Popen|check_output)|\bos\.system\s*\(|\bos\.popen\s*\(/g },
  { capability: "fs_write", re: /\bfs\.(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|chmod|chmodSync)\s*\(|open\s*\([^)]*['"][wa]b?\+?['"]/g },
];

/** Hosts where a fetch is software distribution, not on its own an attack signal. */
export const DISTRIBUTION_HOSTS = [
  "github.com", "githubusercontent.com", "sourceforge.net", "gitlab.com", "bitbucket.org",
  "npmjs.org", "npmjs.com", "pypi.org", "pythonhosted.org", "crates.io", "debian.org", "ubuntu.com",
  "nodejs.org", "yarnpkg.com", "docker.com", "deno.land", "rustup.rs", "python.org", "apache.org",
];

/** Anchored suffix match, so `evil-github.com` and `github.com.evil.example` never pass. */
export function isDistributionHostName(host: string, list: readonly string[] = DISTRIBUTION_HOSTS): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return list.some((d) => h === d || h.endsWith("." + d));
}

export function isInternalIp(ip: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 0 || a === 127 || a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

const POPULAR_PACKAGES = [
  "react", "lodash", "express", "axios", "chalk", "commander", "request", "moment", "webpack", "babel",
  "typescript", "next", "vue", "jquery", "dotenv", "node-fetch", "crypto-js", "bcrypt", "jsonwebtoken",
  "uuid", "colors", "debug", "yargs", "mongoose", "redux", "ethers", "web3", "requests", "numpy", "urllib3",
];

export function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 99;
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length]!;
}

export function typosquatOf(name: string | null): string | null {
  if (!name) return null;
  const bare = name.replace(/^@[^/]+\//, "").toLowerCase();
  if (bare.length < 4 || POPULAR_PACKAGES.includes(bare)) return null;
  for (const p of POPULAR_PACKAGES) {
    const d = editDistance(bare, p);
    if (d >= 1 && d <= 2 && p.length >= 4) return p;
  }
  return null;
}

function lineAt(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) if (content.charCodeAt(i) === 10) line++;
  return line;
}

function snippetAround(content: string, index: number): string {
  return content
    .slice(Math.max(0, index - 60), Math.min(content.length, index + 120))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, SNIPPET_MAX);
}

function runRules(file: string, content: string, rules: Rule[], out: StaticFinding[]): boolean {
  let hit = false;
  for (const r of rules) {
    r.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    let n = 0;
    while ((m = r.re.exec(content)) !== null && n < MAX_MATCHES_PER_RULE_PER_FILE) {
      n++;
      hit = true;
      out.push({
        source: "heuristic",
        rule: r.id,
        severity: r.severity,
        file,
        line: lineAt(content, m.index),
        message: r.message,
        snippet: snippetAround(content, m.index),
      });
      if (m.index === r.re.lastIndex) r.re.lastIndex++;
    }
  }
  return hit;
}

const INSTALL_HOOKS = ["preinstall", "install", "postinstall", "preprepare", "prepare", "postprepare"];

/** Severity of an install-hook command by what it runs. */
export function installCommandSeverity(cmd: string): Severity {
  if (/\b(?:curl|wget)\b[^|;&]*\|\s*(?:ba|z)?sh\b/.test(cmd)) return "high";
  if (/\b(?:curl|wget|nc|ncat|powershell|pwsh)\b|base64\s+(?:-d|--decode)|\bbash\s+-c\b/.test(cmd)) return "medium";
  return "low";
}

function analyzePackageJson(content: string, out: StaticFinding[]): string | null {
  let pkg: { name?: unknown; scripts?: unknown };
  try {
    pkg = JSON.parse(content) as { name?: unknown; scripts?: unknown };
  } catch {
    out.push({ source: "heuristic", rule: "heur.package_json.invalid", severity: "low", file: "package.json", line: null, message: "package.json is not valid JSON" });
    return null;
  }
  const scripts = pkg.scripts && typeof pkg.scripts === "object" ? (pkg.scripts as Record<string, unknown>) : {};
  for (const hook of INSTALL_HOOKS) {
    const cmd = scripts[hook];
    if (typeof cmd !== "string") continue;
    const idx = content.indexOf(`"${hook}"`);
    out.push({
      source: "heuristic",
      rule: "heur.install_hook",
      severity: installCommandSeverity(cmd),
      file: "package.json",
      line: idx >= 0 ? lineAt(content, idx) : null,
      message: `install lifecycle script "${hook}" runs: ${cmd.slice(0, 160)}`,
      snippet: `"${hook}": ${JSON.stringify(cmd).slice(0, SNIPPET_MAX)}`,
    });
  }
  return typeof pkg.name === "string" ? pkg.name : null;
}

const SETUP_PY_RULES: Rule[] = [
  { id: "heur.setup_py.os_system", re: /\bos\.system\s*\(/g, severity: "medium", message: "setup.py runs os.system()" },
  { id: "heur.setup_py.subprocess", re: /\bsubprocess\.(?:run|call|Popen|check_output|check_call)\s*\(/g, severity: "medium", message: "setup.py runs a subprocess" },
  { id: "heur.setup_py.custom_install", re: /\bcmdclass\s*=|class\s+\w*[Ii]nstall\w*\s*\(/g, severity: "low", message: "setup.py overrides an install command" },
  { id: "heur.setup_py.dynamic_exec", re: /\b__import__\s*\(|\bexec\s*\(/g, severity: "medium", message: "setup.py dynamic exec or import" },
];

const SHELL_FETCH_RE = /\b(?:curl|wget)\b[\s\S]{0,80}?\bhttps?:\/\/([A-Za-z0-9.-]+)/g;
const IP_URL_RE = /\bhttps?:\/\/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})|\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):\d{2,5}\b/g;

function isInstallScriptName(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return /^(?:pre|post)?install(?:\.|$)/i.test(name) || /^(?:setup|bootstrap|prepare)(?:\.|$)/i.test(name);
}

export function runHeuristics(files: Map<string, Uint8Array>): HeuristicResult {
  const findings: StaticFinding[] = [];
  const capabilities: HeuristicResult["capabilities"] = [];
  let skipped = 0;
  let packageName: string | null = null;

  for (const [path, bytes] of files) {
    if (bytes.length > MAX_TEXT_BYTES) {
      skipped++;
      continue;
    }
    const content = textOf(bytes);
    if (content === null) {
      skipped++;
      continue;
    }
    if (path === "package.json") packageName = analyzePackageJson(content, findings);
    if (path === "setup.py") runRules(path, content, SETUP_PY_RULES, findings);

    runRules(path, content, OBFUSCATION, findings);
    runRules(path, content, DYNAMIC_CODE, findings);
    runRules(path, content, SECRETS, findings);
    runRules(path, content, CREDENTIAL_PATHS, findings);

    const installCtx = isInstallScriptName(path);
    IP_URL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    let n = 0;
    while ((m = IP_URL_RE.exec(content)) !== null && n < MAX_MATCHES_PER_RULE_PER_FILE) {
      n++;
      const ip = (m[1] ?? m[2])!;
      const internal = isInternalIp(ip);
      findings.push({
        source: "heuristic",
        rule: internal ? "heur.network.internal_ip" : "heur.network.public_ip",
        severity: internal ? "low" : installCtx ? "high" : "medium",
        file: path,
        line: lineAt(content, m.index),
        message: internal ? `hardcoded internal address ${ip}` : `hardcoded public IP ${ip}`,
        snippet: snippetAround(content, m.index),
      });
    }
    SHELL_FETCH_RE.lastIndex = 0;
    n = 0;
    while ((m = SHELL_FETCH_RE.exec(content)) !== null && n < MAX_MATCHES_PER_RULE_PER_FILE) {
      n++;
      const host = m[1]!;
      const internal = isInternalIp(host);
      const dist = !internal && isDistributionHostName(host);
      findings.push({
        source: "heuristic",
        rule: internal ? "heur.shell_fetch.internal" : dist ? "heur.shell_fetch.distribution" : "heur.shell_fetch.unrecognized",
        severity: internal || dist ? "low" : installCtx ? "high" : "medium",
        file: path,
        line: lineAt(content, m.index),
        message: `shell fetch to ${host}`,
        snippet: snippetAround(content, m.index),
      });
    }

    for (const c of CAPABILITY_PATTERNS) {
      c.re.lastIndex = 0;
      if (c.re.test(content)) capabilities.push({ file: path, capability: c.capability });
    }
  }

  const near = typosquatOf(packageName);
  if (near) {
    findings.push({
      source: "heuristic",
      rule: "heur.typosquat",
      severity: "medium",
      file: "package.json",
      line: null,
      message: `package name "${packageName}" is within two edits of popular package "${near}"`,
    });
  }
  return { findings, capabilities, skipped };
}
