/**
 * Test-only Luna ModelAdapter that answers from a script of canned values (or
 * errors) and records each request. Every canned value is validated with the
 * request's own zod schema, exactly as the production adapter does, so a test
 * cannot feed the engine a value the real path would reject.
 */

import { ModelError, type ModelAdapter, type StructuredRequest, type StructuredResult } from "../../lib/engine/model/adapter.ts";

export type ScriptStep = unknown | Error | ((req: StructuredRequest<unknown>) => unknown);

export class ScriptedModel implements ModelAdapter {
  readonly modelId = "test-scripted";
  readonly requests: Array<StructuredRequest<unknown>> = [];
  #steps: ScriptStep[];

  constructor(steps: ScriptStep[]) {
    this.#steps = [...steps];
  }

  async structured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    this.requests.push(req as StructuredRequest<unknown>);
    if (this.#steps.length === 0) throw new Error(`ScriptedModel: no step left for ${req.task}`);
    let step = this.#steps.shift();
    if (typeof step === "function") step = (step as (r: StructuredRequest<unknown>) => unknown)(req as StructuredRequest<unknown>);
    if (step instanceof Error) throw step;
    const checked = req.schema.safeParse(step);
    if (!checked.success) throw new ModelError("invalid_output", checked.error.message);
    return { value: checked.data, usage: { inputTokens: 2100, outputTokens: 120, cachedInputTokens: 1920, cacheWriteTokens: 0 }, rawText: JSON.stringify(step) };
  }
}
