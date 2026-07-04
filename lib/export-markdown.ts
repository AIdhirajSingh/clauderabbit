/**
 * Markdown report export — a pure function that renders a `Report` into a
 * clean, readable Markdown document. Used by `app/api/export/markdown/route.ts`
 * to serve a downloadable `.md` file, and unit-tested directly (no browser, no
 * DOM) since it takes the same `Report` shape the React components render from.
 *
 * Per CLAUDE.md this export must honor the product's two structural rails:
 *   1. Never state a bare "Safe" verdict — `buildReportView`'s `enforceVerdict`
 *      already guards this for the score/verdict pair, so this module renders
 *      the verdict it is given verbatim rather than inventing its own wording.
 *   2. Reputation signals and code/behavior signals stay structurally separate —
 *      rendered as two distinct Markdown sections (`## Reputation signals` and
 *      `## Code & behavior signals`), never blended into one list.
 *
 * The forensic ("what running it revealed") section is included only when the
 * report actually carries a forensic record (an escalated/deep run), mirroring
 * `ReportBody`'s `r._forensics &&` gate — no empty section header over nothing.
 */

import { buildReportView } from "./report-view";
import { formatCount } from "./format";
import type { Report } from "./types";

/** Escape Markdown-significant characters in plain prose so a summary/detail
 * string from a model or a repo's own README can't break the document's
 * structure (e.g. a stray `#` starting a line, or `|` breaking a table cell). */
function escapeMd(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/([*_`|])/g, "\\$1")
    .replace(/^(#{1,6}\s)/gm, "\\$1")
    .replace(/^(>\s)/gm, "\\$1")
    .replace(/^(-\s)/gm, "\\-\\ ")
    .replace(/\r\n/g, "\n");
}

/** Render a Markdown table row from cell strings, escaping `|` and newlines. */
function tableRow(cells: string[]): string {
  return `| ${cells.map((c) => escapeMd(c).replace(/\n/g, " ")).join(" | ")} |`;
}

function heading(level: number, text: string): string {
  return `${"#".repeat(level)} ${text}`;
}

/**
 * Render a full Markdown report for the given `Report`. Pure — no I/O, no
 * React, safe to unit test directly and to call from a server route.
 *
 * `siteUrl` is the real origin the report is published at (the caller's own
 * `NEXT_PUBLIC_SITE_URL`, e.g. `http://localhost:2311` in dev or the real
 * production domain) — never hardcoded here, so the download is honest about
 * where it actually lives regardless of which deployment served it.
 */
export function reportToMarkdown(report: Report, siteUrl: string): string {
  const view = buildReportView(report);
  const lines: string[] = [];

  const slug = `${view.owner}/${view.name}`;
  lines.push(heading(1, `${slug} — ClaudeRabbit safety report`));
  lines.push("");
  lines.push(`**Score:** ${view.score} / 100 (${view._band})`);
  lines.push("");
  // The verdict is rendered exactly as the enforced/derived value the UI shows —
  // `buildReportView` already guarantees this is never a bare "Safe".
  lines.push(`**Verdict:** ${escapeMd(view.verdict)}`);
  lines.push("");
  lines.push(
    view._ranSandbox
      ? "**Scan type:** Sandbox run — the code was executed in an isolated, hermetic sandbox."
      : view.deep
        ? "**Scan type:** Sandbox run incomplete — escalation was flagged but the dynamic run did not complete; this reflects the static read only."
        : "**Scan type:** Static read — the code was read and scored without executing it in a sandbox.",
  );
  lines.push("");
  if (view.cached) {
    lines.push("_Served from cache._");
    lines.push("");
  }
  lines.push(escapeMd(view.summary));
  lines.push("");

  // ── top-line stats ──
  lines.push(heading(2, "Repository stats"));
  lines.push("");
  lines.push(tableRow(["Metric", "Value"]));
  lines.push(tableRow(["---", "---"]));
  lines.push(tableRow(["Repository size", view.stats.loc]));
  lines.push(tableRow(["Packages", formatCount(view.stats.packages)]));
  lines.push(tableRow(["Stars", view.stats.stars]));
  lines.push(tableRow(["Created", view.stats.created]));
  lines.push("");

  // ── reputation signals (kept structurally separate from code/behavior) ──
  lines.push(heading(2, "Reputation signals"));
  lines.push("");
  lines.push(`Owner: **${escapeMd(view.ownerHistory.name)}** (@${escapeMd(view.ownerHistory.handle)})`);
  lines.push("");
  lines.push(tableRow(["Signal", "Value"]));
  lines.push(tableRow(["---", "---"]));
  lines.push(tableRow(["Account age", view.ownerHistory.age]));
  lines.push(tableRow(["Public repos", formatCount(view.ownerHistory.repos)]));
  lines.push(tableRow(["Forks", view.reputation.forks]));
  lines.push(tableRow(["Community sentiment", `${view._repBar}/100`]));
  lines.push("");
  lines.push(escapeMd(view.reputation.sentiment));
  lines.push("");
  if (view.ownerHistory.note) {
    lines.push(escapeMd(view.ownerHistory.note));
    lines.push("");
  }

  // ── code & behavior signals (kept structurally separate from reputation) ──
  lines.push(heading(2, "Code & behavior signals"));
  lines.push("");
  if (view._hasRisky) {
    for (const x of view.risky) {
      lines.push(heading(3, `${x._sevLabel} — ${escapeMd(x.title)} (${x._kindLabel})`));
      lines.push("");
      lines.push(escapeMd(x.detail));
      lines.push("");
    }
  } else {
    lines.push(
      "No risky items found. No signatures, install hooks, obfuscation, or embedded secrets were found in the code.",
    );
    lines.push("");
  }

  // ── per-package scoring ──
  if (view.packages.length > 0) {
    lines.push(heading(2, "Per-package scoring"));
    lines.push("");
    lines.push(tableRow(["Package", "Score", "Note"]));
    lines.push(tableRow(["---", "---", "---"]));
    for (const p of view.packages) {
      lines.push(tableRow([p.name, String(p.score), p.note]));
    }
    lines.push("");
  }

  // ── forensics / sandbox findings (only when the sandbox actually ran) ──
  const f = view._forensics;
  if (f) {
    lines.push(heading(2, "What running it revealed"));
    lines.push("");

    const run = f.raw.what_it_ran;
    lines.push(heading(3, "What it ran"));
    lines.push("");
    lines.push(tableRow(["Field", "Value"]));
    lines.push(tableRow(["---", "---"]));
    if (run.project_type) lines.push(tableRow(["Project type", run.project_type]));
    if (run.install_command) lines.push(tableRow(["Install", run.install_command]));
    if (run.run_command) lines.push(tableRow(["Run", run.run_command]));
    lines.push(tableRow(["Auto-build", run.auto_build_succeeded ? "Built unattended" : "Did not build"]));
    lines.push(tableRow(["Ran to completion", run.ran_without_crash ? "Yes" : "No / crashed"]));
    lines.push("");

    if (f.raw.verdict.code_behavior_findings.length > 0) {
      lines.push(heading(3, "Three agents read the code"));
      lines.push("");
      lines.push(
        "Three agents — install-time, runtime, and payload — read the source in parallel and cross-verified. " +
          "These are inferences from reading the code; the runtime facts below are what actually happened when we ran it.",
      );
      lines.push("");
      for (const cf of f.raw.verdict.code_behavior_findings) {
        const sevLabel = cf.severity === "high" ? "High" : cf.severity === "med" ? "Medium" : "Low";
        lines.push(`- **${sevLabel} — ${escapeMd(cf.signal)}** (code read, not confirmed at runtime)${cf.detail ? `: ${escapeMd(cf.detail)}` : ""}`);
      }
      lines.push("");
    }

    lines.push(heading(3, "Network intent — what it tried to reach"));
    lines.push("");
    if (f._namedAttempts.length > 0) {
      lines.push(tableRow(["Domain called", "Routing", "Geolocation", "Port"]));
      lines.push(tableRow(["---", "---", "---", "---"]));
      for (const a of f._namedAttempts) {
        const host = a.intended_host ?? a.http_host_header ?? a.sni ?? "—";
        lines.push(
          tableRow([host, "not routed to", a._geoLabel || "unresolved", a.dest_port != null ? String(a.dest_port) : "—"]),
        );
      }
      lines.push("");
      if (f._blockedNoHostCount > 0) {
        lines.push(
          `+ ${f._blockedNoHostCount} further outbound attempt(s) intercepted with no resolved destination.`,
        );
        lines.push("");
      }
      lines.push("_Intended IPs were resolved off-VM for intelligence only and were never routed to._");
      lines.push("");
    } else if (f._blockedNoHostCount > 0) {
      lines.push(
        `${f._blockedNoHostCount} outbound connection attempt(s) were intercepted by the sandbox sinkhole, ` +
          "but none resolved a named destination. No exfiltration target was captured during this run.",
      );
      lines.push("");
    } else {
      lines.push("No outbound connection attempts were observed during this run.");
      lines.push("");
    }

    if (f._payloads.length > 0) {
      lines.push(heading(3, "Attempted exfil payload (captured, never delivered)"));
      lines.push("");
      for (const p of f._payloads) {
        lines.push(`_${p.host ? `to ${escapeMd(p.host)}` : "captured payload"} — ${p.bytesLen} bytes, inert_`);
        lines.push("");
        lines.push("```");
        lines.push(p.text + (p.truncated ? "\n… (truncated)" : ""));
        lines.push("```");
        lines.push("");
      }
    }

    const beh = f.raw.in_vm_behavior;
    lines.push(heading(3, "In-VM behavior"));
    lines.push("");
    lines.push(tableRow(["Metric", "Value"]));
    lines.push(tableRow(["---", "---"]));
    lines.push(tableRow(["High-value credential reads", String(beh.high_value_credential_reads)]));
    lines.push(tableRow(["Processes spawned", String(beh.process_exec_count)]));
    lines.push(tableRow(["Files dropped", String(beh.files_dropped_count)]));
    lines.push(
      tableRow(["CPU", beh.high_cpu ? "High (mining-class)" : `${beh.run_cpu_cores_busy.toFixed(2)} cores busy`]),
    );
    lines.push("");
    const highValueReads = beh.credential_reads_detail.filter((c) => c.high_value);
    if (highValueReads.length > 0) {
      lines.push("Credential paths it read (decoys planted by the sandbox):");
      lines.push("");
      for (const c of highValueReads) {
        lines.push(`- \`${c.path}\`${c.succeeded ? " (read)" : ""}`);
      }
      lines.push("");
    }

    const cont = f.raw.containment;
    lines.push(heading(3, "Containment proof"));
    lines.push("");
    lines.push(
      cont.no_real_packet_reached_destination
        ? "No real packet reached its intended destination."
        : "**Containment was NOT confirmed for this run.**",
    );
    lines.push("");
    if (cont.containment_notes) {
      lines.push(escapeMd(cont.containment_notes));
      lines.push("");
    } else if (!cont.no_real_packet_reached_destination) {
      lines.push(
        "This run did not produce a positive proof that egress was fully contained. Treat any captured " +
          "outbound attempt as potentially uncontained and run this code only inside a disposable environment.",
      );
      lines.push("");
    }
    lines.push(`- External monitor saw the egress attempt: ${cont.external_monitor_saw_egress ? "yes" : "no"}`);
    lines.push(`- In-VM trace corroborated it: ${cont.in_vm_saw_egress ? "yes" : "no"}`);
    lines.push("");
  }

  // ── final verdict ──
  lines.push(heading(2, "Final verdict"));
  lines.push("");
  lines.push(escapeMd(view._finalNote));
  lines.push("");
  if (view._notVerified.length > 0) {
    lines.push("**What we could not verify:**");
    lines.push("");
    for (const nv of view._notVerified) {
      lines.push(`- ${escapeMd(nv)}`);
    }
    lines.push("");
  }

  // ── end-to-end logs ──
  if (view.logs.length > 0) {
    lines.push(heading(2, "End-to-end logs"));
    lines.push("");
    for (const l of view.logs) {
      lines.push(heading(3, l.ch));
      lines.push("");
      for (const ln of l.lines) {
        lines.push(`- ${escapeMd(ln)}`);
      }
      lines.push("");
    }
  }

  lines.push("---");
  lines.push("");
  const origin = siteUrl.replace(/\/+$/, "").replace(/^https?:\/\//, "");
  lines.push(`_Auto-published at ${origin}/${slug} · re-checked when the repo changes._`);
  lines.push("");

  return lines.join("\n");
}
