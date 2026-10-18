/**
 * The two model seams of a scan.
 *
 *  - Jev (model/jev.ts): every model-judged check. A decision model on Vercel
 *    AI Gateway that answers typed questions (choice, boolean) about one shared
 *    state. It never writes text and never sets the score.
 *  - Luna (this file, `ModelAdapter`; production `OpenAIAdapter` in
 *    model/openai.ts): exactly one call per fresh scan, the report text, from
 *    the deterministic score and the Jev answers.
 *
 * Both report token usage in one shape so the cost ledger (lib/engine/cost.ts)
 * prices every call the same way.
 */

import type { z } from "zod";

/** The one Luna task. Checks run on Jev, never through this seam. */
export type ModelTask = "report";

/**
 * Token usage of one model call. `inputTokens` counts every input token,
 * including the cached and cache-write ones (OpenAI and the gateway both report
 * it that way); `cachedInputTokens` and `cacheWriteTokens` are subsets of it.
 */
export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
}

export const ZERO_USAGE: ModelUsage = Object.freeze({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0 });

export interface StructuredRequest<T> {
  task: ModelTask;
  /** Long static instructions. Sent first so the provider's prompt cache keeps them as a stable prefix. */
  system: string;
  /** Per-scan facts. Sent last. */
  input: string;
  schema: z.ZodType<T>;
  schemaName: string;
  maxOutputTokens: number;
  /** Routes requests with the same static prefix to the same prompt cache. */
  promptCacheKey: string;
  signal: AbortSignal;
}

export interface StructuredResult<T> {
  value: T;
  usage: ModelUsage;
  rawText: string;
}

export interface ModelAdapter {
  readonly modelId: string;
  structured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>>;
}

export type ModelErrorKind = "refusal" | "invalid_output" | "incomplete" | "rate_limited" | "timeout" | "upstream" | "auth" | "billing";

export class ModelError extends Error {
  readonly kind: ModelErrorKind;
  constructor(kind: ModelErrorKind, message: string) {
    super(message);
    this.name = "ModelError";
    this.kind = kind;
  }
}
