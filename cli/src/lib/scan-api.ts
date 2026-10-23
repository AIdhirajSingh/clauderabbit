/**
 * ClaudeRabbit 2.0 scan API client (DESIGN.md section 8.2), shared verbatim by
 * the CLI (cli/src/lib/scan-api.ts) and the stdio MCP server
 * (mcp-server/src/scan-api.ts). POSTs to `${siteUrl}/api/scan` with the saved
 * `cr_cli_` token and `x-clauderabbit-client`, reads the NDJSON stream (event
 * lines, then one result or error line), and renders verdict, score, evidence,
 * `not_verified`, report URL and the ad. A missing or invalid token comes back
 * as 401 with `signInUrl`. Never a bare "Safe": the verdict words come from
 * the server's fixed set and the not-verified list is always printed.
 */

export type Ad =
  | { kind: "adsense"; placement: "scan_result"; client: string; slot: string; format: "auto"; adtest: "on" | "off" }
  | { kind: "house"; placement: "scan_result"; id: string; label: "Sponsored"; headline: string; body: string; url: string };

export interface EngineReport {
  run_id: string;
  target: string;
  commit_sha: string;
  score: number;
  verdict: string;
  band: "green" | "blue" | "yellow" | "red";
  summary: string;
  headline: string;
  evidence: { behaviour: string[]; code: string[]; reputation: string[] };
  breakdown: Array<{ group: string; code: string; points: number; detail: string }>;
  not_verified: string[];
  model_id: string;
  template: string;
  timings: Record<string, number>;
}

export interface StageEvent {
  type: "stage";
  seq: number;
  data: { name: string; status: "start" | "done" | "error" | "skipped"; detail?: string };
}

export interface AnyEvent {
  type: string;
  seq: number;
  t_ms: number;
  data: Record<string, unknown>;
  replayed?: boolean;
}

export type ScanTarget = { ecosystem: "github"; owner: string; repo: string; ref?: string } | { ecosystem: "npm"; package: string; version?: string };

export type ScanResponse =
  | { ok: true; outcome: "cached" | "fresh"; runId: string; report: EngineReport; reportUrl: string; ad: Ad; realtimeChannel?: string }
  | { ok: false; status: number; code: string; message: string; signInUrl?: string; retryAfter?: number; ad?: Ad };

export interface ScanApiConfig {
  siteUrl: string;
  scanTimeoutMs: number;
  /** Vercel deployment-protection bypass for a protected Preview; sent only as a header, never logged. */
  protectionBypass?: string;
}

/** The plain-text form of an ad for terminals and MCP text content. */
export function adText(ad: Ad | undefined): string {
  if (!ad) return "";
  if (ad.kind === "house") return `[${ad.label}] ${ad.headline}: ${ad.body} ${ad.url}`;
  return "[Sponsored] Advertisement shown on the ClaudeRabbit web report.";
}

/** Parse complete NDJSON lines; the trailing partial line is returned as rest. */
export function splitLines(buffer: string): { lines: string[]; rest: string } {
  const parts = buffer.split("\n");
  const rest = parts.pop() ?? "";
  return { lines: parts.filter((l) => l.trim().length > 0), rest };
}

/** Interpret one parsed NDJSON object; returns the final response when it is the last line. */
export function interpretLine(msg: Record<string, unknown>, onEvent?: (e: AnyEvent) => void): ScanResponse | null {
  if (msg.type === "event" && msg.event && typeof msg.event === "object") {
    onEvent?.(msg.event as AnyEvent);
    return null;
  }
  if (msg.type === "result") {
    return {
      ok: true,
      outcome: msg.outcome === "cached" ? "cached" : "fresh",
      runId: String(msg.run_id ?? ""),
      report: msg.report as EngineReport,
      reportUrl: String(msg.report_url ?? ""),
      ad: msg.ad as Ad,
      ...(typeof msg.realtime_channel === "string" ? { realtimeChannel: msg.realtime_channel } : {}),
    };
  }
  if (msg.type === "error") {
    return {
      ok: false,
      status: 200,
      code: String(msg.code ?? "internal"),
      message: String(msg.message ?? "scan failed"),
      ...(msg.ad ? { ad: msg.ad as Ad } : {}),
    };
  }
  return null;
}

export function requestBody(target: ScanTarget): Record<string, string> {
  return target.ecosystem === "npm"
    ? { ecosystem: "npm", package: target.package, ...(target.version ? { version: target.version } : {}) }
    : { ecosystem: "github", owner: target.owner, repo: target.repo, ...(target.ref ? { ref: target.ref } : {}) };
}

export async function postScan(
  config: ScanApiConfig,
  target: ScanTarget,
  token: string | null,
  client: "cli" | "mcp",
  onEvent?: (e: AnyEvent) => void,
  fetchImpl: typeof fetch = fetch,
): Promise<ScanResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.scanTimeoutMs);
  try {
    let res: Response;
    try {
      res = await fetchImpl(`${config.siteUrl.replace(/\/+$/, "")}/api/scan`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/x-ndjson",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          "x-clauderabbit-client": client,
          ...(config.protectionBypass ? { "x-vercel-protection-bypass": config.protectionBypass } : {}),
        },
        body: JSON.stringify(requestBody(target)),
        signal: controller.signal,
      });
    } catch (err) {
      const message = controller.signal.aborted ? `no result within ${Math.round(config.scanTimeoutMs / 1000)} s` : `network error: ${(err as Error).message}`;
      return { ok: false, status: 0, code: "network", message };
    }
    if (!res.ok || !res.body) {
      let body: Record<string, unknown> = {};
      try {
        body = (await res.json()) as Record<string, unknown>;
      } catch {
        // Non-JSON body: report the status.
      }
      return {
        ok: false,
        status: res.status,
        code: String(body.code ?? body.error ?? `http_${res.status}`),
        message: String(body.message ?? `HTTP ${res.status}`),
        ...(typeof body.signInUrl === "string" ? { signInUrl: body.signInUrl } : {}),
        ...(typeof body.retryAfter === "number" ? { retryAfter: body.retryAfter } : {}),
        ...(body.ad ? { ad: body.ad as Ad } : {}),
      };
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let final: ScanResponse | null = null;
    for (;;) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() + "\n" : decoder.decode(value, { stream: true });
      const { lines, rest } = splitLines(buffer);
      buffer = rest;
      for (const line of lines) {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        const r = interpretLine(msg, onEvent);
        if (r) final = r;
      }
      if (done) break;
    }
    return final ?? { ok: false, status: res.status, code: "stream", message: "the scan stream ended without a result" };
  } finally {
    clearTimeout(timer);
  }
}

/** One progress line for a stage event, or null for other event types. */
export function stageLine(e: AnyEvent): string | null {
  if (e.type !== "stage") return null;
  const d = e.data as StageEvent["data"];
  const tail = d.detail ? `: ${d.detail}` : "";
  if (d.status === "start") return `  . ${d.name}`;
  if (d.status === "done") return `  + ${d.name}${tail}`;
  if (d.status === "skipped") return `  - ${d.name} skipped${tail}`;
  return `  ! ${d.name} error${tail}`;
}

/** Full plain-text report: verdict, score, points taken off, evidence groups, not verified, the full report URL. No ads. */
export function formatResponse(r: ScanResponse): string {
  if (!r.ok) {
    const lines = [`ClaudeRabbit scan failed (${r.code}): ${r.message}`];
    if (r.signInUrl) lines.push(`Sign in at ${r.signInUrl}, then run \`clauderabbit login\`.`);
    if (r.retryAfter) lines.push(`Retry in ${r.retryAfter} s.`);
    return lines.join("\n") + "\n";
  }
  const p = r.report;
  const lines: string[] = [];
  lines.push(`${p.target} @ ${p.commit_sha.slice(0, 40)}`);
  lines.push(`Verdict: ${p.verdict}   Score: ${p.score}/100${r.outcome === "cached" ? "   (cached report for this exact commit)" : ""}`);
  if (p.headline) lines.push(p.headline);
  if (p.summary) lines.push("", p.summary);
  const group = (title: string, items: string[]) => {
    if (!items || items.length === 0) return;
    lines.push("", `${title}:`);
    for (const i of items.slice(0, 12)) lines.push(`  - ${i}`);
  };
  const deductions = (p.breakdown ?? []).filter((d) => d.points !== 0).map((d) => `${d.points > 0 ? "+" : ""}${d.points} ${d.detail}`);
  group("Points taken off", deductions.length ? deductions : ["none"]);
  group("Observed when the code ran", p.evidence?.behaviour ?? []);
  group("Found in the code", p.evidence?.code ?? []);
  group("Reputation (separate from code and behaviour)", p.evidence?.reputation ?? []);
  lines.push("", "Not verified:");
  const nv = p.not_verified?.length ? p.not_verified : ["The server sent no not-verified list; treat every unobserved path as unverified."];
  for (const i of nv) lines.push(`  - ${i}`);
  lines.push("", `Full report: ${r.reportUrl}`);
  return lines.join("\n") + "\n";
}

/** JSON form for `--json` and MCP structured content. */
export function toStructured(r: ScanResponse): Record<string, unknown> {
  if (!r.ok) return { ok: false, code: r.code, message: r.message, ...(r.signInUrl ? { signInUrl: r.signInUrl } : {}) };
  const p = r.report;
  return {
    ok: true,
    outcome: r.outcome,
    runId: r.runId,
    target: p.target,
    commitSha: p.commit_sha,
    score: p.score,
    verdict: p.verdict,
    band: p.band,
    headline: p.headline,
    summary: p.summary,
    evidence: p.evidence,
    notVerified: p.not_verified,
    breakdown: p.breakdown,
    deductions: (p.breakdown ?? []).filter((d) => d.points !== 0).map((d) => ({ points: d.points, detail: d.detail })),
    reportUrl: r.reportUrl,
  };
}
