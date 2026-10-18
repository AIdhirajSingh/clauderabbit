/**
 * Test-only stand-in for Luna, the report writer. Deterministic structured
 * output derived from the request's facts, returned through ScriptedModel so
 * every answer is validated with the same zod schema the production adapter
 * enforces. Records every request so tests can count Luna calls. Never
 * imported by production code.
 */

import type { ModelAdapter, StructuredRequest, StructuredResult } from "../../lib/engine/model/adapter.ts";
import { ScriptedModel } from "./scripted-model.ts";

function report(req: StructuredRequest<unknown>) {
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
    if (req.task !== "report") throw new Error(`StandInModel: Luna only writes the report, got ${String(req.task)}`);
    return new ScriptedModel([(r: StructuredRequest<unknown>) => report(r)]).structured(req);
  }
}
