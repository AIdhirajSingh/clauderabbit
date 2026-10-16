/**
 * Parsers for the scanner output produced inside the analysis sandbox
 * (DESIGN.md sections 2.1, 4): Semgrep `--json`, GuardDog `--output-format=json`
 * and our own `cr-yara.py` JSON. The tools run in an E2B VM with no network on
 * the extracted tree (rooted at `root`, `/work/src` by default); paths are made
 * relative to that root so they line up with the archive map and the
 * reachability graph.
 *
 * cr-yara.py output contract (written by sandbox/e2b/guest/cr-yara.py):
 *   { "matches": [ { "rule": str, "namespace": str, "path": str,
 *       "line": int | null, "tags": [str], "meta": { "severity"?: "high"|"medium"|"low",
 *       "description"?: str } } ], "errors": [str] }
 */

import type { Severity, StaticFinding } from "../types";

export const SCAN_ROOT = "/work/src";

export interface ScannerParse {
  findings: StaticFinding[];
  errors: string[];
}

export function relativeToRoot(path: string, root = SCAN_ROOT): string {
  let p = path.replace(/\\/g, "/");
  const r = root.replace(/\/+$/, "");
  if (p.startsWith(r + "/")) p = p.slice(r.length + 1);
  return p.replace(/^\.\//, "");
}

function parseJson(text: string, tool: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${tool} output is not valid JSON`);
  }
}

const SEMGREP_SEVERITY: Record<string, Severity> = {
  CRITICAL: "high",
  ERROR: "high",
  HIGH: "high",
  WARNING: "medium",
  MEDIUM: "medium",
  INFO: "low",
  LOW: "low",
  INVENTORY: "low",
  EXPERIMENT: "low",
};

export function parseSemgrep(text: string, root = SCAN_ROOT): ScannerParse {
  const body = parseJson(text, "semgrep") as {
    results?: Array<{
      check_id?: unknown;
      path?: unknown;
      start?: { line?: unknown };
      extra?: { message?: unknown; severity?: unknown; lines?: unknown };
    }>;
    errors?: Array<{ message?: unknown; type?: unknown }>;
  };
  const findings: StaticFinding[] = [];
  for (const r of Array.isArray(body.results) ? body.results : []) {
    if (typeof r?.check_id !== "string" || typeof r.path !== "string") continue;
    const sev = typeof r.extra?.severity === "string" ? SEMGREP_SEVERITY[r.extra.severity.toUpperCase()] : undefined;
    findings.push({
      source: "semgrep",
      rule: r.check_id,
      severity: sev ?? "medium",
      file: relativeToRoot(r.path, root),
      line: typeof r.start?.line === "number" ? r.start.line : null,
      message: typeof r.extra?.message === "string" ? r.extra.message.slice(0, 500) : r.check_id,
      ...(typeof r.extra?.lines === "string" ? { snippet: r.extra.lines.slice(0, 240) } : {}),
    });
  }
  const errors = (Array.isArray(body.errors) ? body.errors : []).map((e) =>
    typeof e?.message === "string" ? e.message.slice(0, 300) : String(e?.type ?? "semgrep error"),
  );
  return { findings, errors };
}

/** GuardDog rule names whose hits are strong malware tells. */
const GUARDDOG_HIGH = new Set([
  "exec-base64", "npm-exec-base64", "exfiltrate-sensitive-data", "npm-exfiltrate-sensitive-data",
  "download-executable", "dll-hijacking", "npm-dll-hijacking", "steganography", "npm-steganography",
  "silent-process-execution", "npm-silent-process-execution", "obfuscation", "npm-obfuscation",
  "code-execution", "cmd-overwrite", "api-obfuscation", "npm-api-obfuscation", "bidirectional-characters",
]);
const GUARDDOG_MEDIUM = new Set([
  "npm-install-script", "shady-links", "npm-serialize-environment", "clipboard-access",
  "suspicious_passwd_access_linux", "typosquatting", "npm-typosquatting",
]);

function guarddogSeverity(rule: string): Severity {
  if (GUARDDOG_HIGH.has(rule)) return "high";
  if (GUARDDOG_MEDIUM.has(rule)) return "medium";
  return "low";
}

/** Split GuardDog's `location` (`path:line`) into its parts. */
export function splitLocation(location: string): { file: string; line: number | null } {
  const m = /^(.*):(\d+)$/.exec(location);
  if (m) return { file: m[1]!, line: Number(m[2]) };
  return { file: location, line: null };
}

export function parseGuardDog(text: string, root = SCAN_ROOT): ScannerParse {
  const body = parseJson(text, "guarddog") as { results?: Record<string, unknown>; errors?: Record<string, unknown> };
  const findings: StaticFinding[] = [];
  for (const [rule, value] of Object.entries(body.results ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (Array.isArray(value)) {
      for (const hit of value) {
        const h = hit as { location?: unknown; code?: unknown; message?: unknown };
        const loc = typeof h?.location === "string" ? splitLocation(h.location) : { file: "", line: null };
        findings.push({
          source: "guarddog",
          rule: `guarddog.${rule}`,
          severity: guarddogSeverity(rule),
          file: relativeToRoot(loc.file, root),
          line: loc.line,
          message: typeof h?.message === "string" ? h.message.slice(0, 500) : rule,
          ...(typeof h?.code === "string" ? { snippet: h.code.slice(0, 240) } : {}),
        });
      }
    } else if (typeof value === "string" && value.trim()) {
      // Metadata rules report one message for the package manifest.
      findings.push({
        source: "guarddog",
        rule: `guarddog.${rule}`,
        severity: guarddogSeverity(rule),
        file: "package.json",
        line: null,
        message: value.slice(0, 500),
      });
    }
  }
  const errors = Object.entries(body.errors ?? {}).map(([k, v]) => `${k}: ${String(v).slice(0, 300)}`);
  return { findings, errors };
}

export function parseCrYara(text: string, root = SCAN_ROOT): ScannerParse {
  const body = parseJson(text, "cr-yara") as {
    matches?: Array<{ rule?: unknown; namespace?: unknown; path?: unknown; line?: unknown; meta?: { severity?: unknown; description?: unknown } }>;
    errors?: unknown[];
  };
  const findings: StaticFinding[] = [];
  for (const m of Array.isArray(body.matches) ? body.matches : []) {
    if (typeof m?.rule !== "string" || typeof m.path !== "string") continue;
    const sev = m.meta?.severity;
    findings.push({
      source: "yara",
      rule: `yara.${typeof m.namespace === "string" && m.namespace ? `${m.namespace}.` : ""}${m.rule}`,
      severity: sev === "high" || sev === "medium" || sev === "low" ? sev : "medium",
      file: relativeToRoot(m.path, root),
      line: typeof m.line === "number" ? m.line : null,
      message: typeof m.meta?.description === "string" ? m.meta.description.slice(0, 500) : m.rule,
    });
  }
  const errors = (Array.isArray(body.errors) ? body.errors : []).map((e) => String(e).slice(0, 300));
  return { findings, errors };
}
