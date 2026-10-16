/**
 * Test-only stand-in for the Luna model. Deterministic structured output
 * derived from the request's own input slice, returned through ScriptedModel so
 * every answer is validated with the same zod schema the production adapter
 * enforces. Never imported by production code.
 */

import type { ModelAdapter, StructuredRequest, StructuredResult } from "../../lib/engine/model/adapter.ts";
import { ScriptedModel } from "./scripted-model.ts";

/** Labels the readers put on each untrusted block: `<<<UNTRUSTED <label>>>>`. */
function blocks(input: string): Array<{ label: string; body: string }> {
  const out: Array<{ label: string; body: string }> = [];
  const re = /<<<UNTRUSTED ([^>]*)>>>\n([\s\S]*?)\n<<<END>>>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) out.push({ label: m[1]!, body: m[2]! });
  return out;
}

const NETWORK_RE = /\b(?:https?\.request|https?\.get|fetch\(|net\.connect|XMLHttpRequest)\b|\bhttps?\.request\(|\.request\(/;
const ENV_RE = /process\.env\.[A-Z_]{3,}/;

function codeReader(req: StructuredRequest<unknown>) {
  const findings = [];
  for (const b of blocks(req.input)) {
    const file = b.label.split(" ")[0]!;
    if (!/\.(?:[cm]?js|ts|py)$/.test(file)) continue;
    if (NETWORK_RE.test(b.body) && ENV_RE.test(b.body)) {
      findings.push({
        file,
        line: null,
        severity: "high" as const,
        verdict: "malicious" as const,
        title: "Install-time code sends an environment credential over the network",
        rationale: "The script reads a credential environment variable and sends it in an HTTPS request during install.",
      });
    }
  }
  return {
    summary: findings.length > 0 ? `${findings.length} install-time exfiltration pattern(s) in the shown code.` : "The shown code has no install-time network or credential access.",
    findings,
  };
}

function docsReader(req: StructuredRequest<unknown>) {
  const desc = /"description":"([^"]*)"/.exec(req.input)?.[1] ?? "";
  return {
    summary: desc ? `Documentation describes: ${desc}` : "No documentation in the slice.",
    stated_purpose: desc || "not stated",
    declares_no_network: false,
    declares_pure: false,
    declaration_quote: null,
    findings: [],
  };
}

function writer(req: StructuredRequest<unknown>) {
  const head = req.input.split("\n<<<UNTRUSTED")[0]!;
  const facts = JSON.parse(head) as {
    score: number;
    verdict: string;
    breakdown: Array<{ group: string; detail: string }>;
    not_verified: string[];
  };
  const behaviour = facts.breakdown.filter((d) => d.group === "behaviour").map((d) => d.detail.replace(/\.$/, ""));
  const rep = facts.breakdown.filter((d) => d.group === "reputation").map((d) => d.detail.replace(/\.$/, ""));
  const parts = [
    `${facts.verdict}, score ${facts.score} of 100.`,
    behaviour.length > 0 ? `In the sandbox run: ${behaviour.join("; ")}.` : "In the sandbox run the forge saw no contact outside the package registries.",
    `Reputation, separate from code: ${rep.length > 0 ? rep.join("; ") : "no reputation signal moved the score"}.`,
    `Not verified: ${facts.not_verified.slice(0, 2).map((n) => n.replace(/\.$/, "")).join("; ")}.`,
  ];
  return { headline: `${facts.verdict} after install and entry ran in the sandbox`, summary: parts.join(" ") };
}

export class StandInModel implements ModelAdapter {
  readonly modelId = "test-stand-in";
  readonly requests: Array<StructuredRequest<unknown>> = [];

  async structured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    this.requests.push(req as StructuredRequest<unknown>);
    const step = (r: StructuredRequest<unknown>) => {
      switch (r.task) {
        case "reader.install":
        case "reader.flagged":
          return codeReader(r);
        case "reader.docs":
          return docsReader(r);
        case "writer":
          return writer(r);
      }
    };
    return new ScriptedModel([step]).structured(req);
  }
}
