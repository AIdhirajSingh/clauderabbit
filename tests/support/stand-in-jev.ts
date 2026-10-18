/**
 * Test-only Jev adapters. Never imported by production code.
 *
 *  - ScriptedJev: answers from a script of canned answer maps (or errors) and
 *    records each request.
 *  - StandInJev: deterministic answers derived from the request's own state:
 *    a block whose code reads a credential environment variable and makes a
 *    network request is malicious; everything else is benign. Docs booleans
 *    follow the README text.
 *
 * Both run every answer through `checkedAnswers`, the validator the
 * production adapter uses, so a test cannot feed the engine an answer the real
 * path would reject.
 */

import { checkedAnswers, type JevAdapter, type JevAnswer, type JevRequest, type JevResult } from "../../lib/engine/model/jev.ts";

export const STAND_IN_JEV_USAGE = { inputTokens: 900, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0 };

export type JevStep = Record<string, unknown> | Error | ((req: JevRequest) => Record<string, unknown>);

export class ScriptedJev implements JevAdapter {
  readonly modelId: string;
  readonly requests: JevRequest[] = [];
  #steps: JevStep[];

  constructor(steps: JevStep[], modelId = "typesafe-ai/jev") {
    this.#steps = [...steps];
    this.modelId = modelId;
  }

  async decide(req: JevRequest): Promise<JevResult> {
    this.requests.push(req);
    if (this.#steps.length === 0) throw new Error(`ScriptedJev: no step left for ${req.task}`);
    let step = this.#steps.shift()!;
    if (typeof step === "function") step = step(req);
    if (step instanceof Error) throw step;
    return { answers: checkedAnswers(req.questions, step), usage: { ...STAND_IN_JEV_USAGE }, servedModelId: this.modelId };
  }
}

function blocks(state: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /<<<UNTRUSTED ([^>]*)>>>\n([\s\S]*?)\n<<<END>>>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(state)) !== null) out.set(m[1]!, m[2]!);
  return out;
}

const NETWORK_RE = /\b(?:https?\.request|https?\.get|fetch\(|net\.connect|XMLHttpRequest)\b|\bhttps?\.request\(|\.request\(/;
const ENV_RE = /process\.env\.[A-Z_]{3,}/;

function verdictOf(body: string | undefined): string {
  if (body === undefined) return "unclear";
  return NETWORK_RE.test(body) && ENV_RE.test(body) ? "malicious" : "benign";
}

function choice(c: string, options: string[]): JevAnswer {
  const probabilities: Record<string, number> = {};
  for (const o of options) probabilities[o] = o === c ? 0.94 : 0.06 / (options.length - 1);
  return { type: "choice", choice: c, probabilities };
}

export function standInAnswers(req: JevRequest): Record<string, unknown> {
  const b = blocks(req.state);
  const all = [...b.values()].join("\n");
  const out: Record<string, unknown> = {};
  for (const [id, q] of Object.entries(req.questions)) {
    if (q.type === "boolean") {
      let p = 0.03;
      if (id === "install_network") p = NETWORK_RE.test(all) ? 0.96 : 0.03;
      else if (id === "install_credentials") p = ENV_RE.test(all) ? 0.93 : 0.03;
      else if (id === "declares_no_network") p = /no network requests|offline/i.test(all) ? 0.91 : 0.04;
      else if (id === "declares_pure") p = /\bpure\b|no side effects/i.test(all) ? 0.9 : 0.04;
      out[id] = { type: "boolean", probability: p };
      continue;
    }
    const options = Object.keys(q.criteria);
    if (id === "capability_fit") {
      out[id] = choice("consistent", options);
      continue;
    }
    const label = /labelled "(.*)": |labelled "(.*)" is a window/.exec(q.instructions);
    const want = label?.[1] ?? label?.[2];
    const body = want === undefined ? undefined : (b.get(want) ?? [...b.entries()].find(([k]) => k.startsWith(want))?.[1]);
    out[id] = choice(verdictOf(body), options);
  }
  return out;
}

export class StandInJev implements JevAdapter {
  readonly modelId = "typesafe-ai/jev";
  readonly requests: JevRequest[] = [];

  async decide(req: JevRequest): Promise<JevResult> {
    this.requests.push(req);
    return { answers: checkedAnswers(req.questions, standInAnswers(req)), usage: { ...STAND_IN_JEV_USAGE }, servedModelId: this.modelId };
  }
}
