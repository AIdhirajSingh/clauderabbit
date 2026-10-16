/**
 * The one model seam (DESIGN.md section 4). The engine talks to a model only
 * through `ModelAdapter.structured`, which returns a value already validated
 * against the caller's zod schema. Production uses `OpenAIAdapter`
 * (model/openai.ts); tests use a stand-in under tests/support.
 */

import type { z } from "zod";

export type ModelTask = "reader.install" | "reader.flagged" | "reader.docs" | "writer";

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface StructuredRequest<T> {
  task: ModelTask;
  system: string;
  input: string;
  schema: z.ZodType<T>;
  schemaName: string;
  maxOutputTokens: number;
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

export type ModelErrorKind = "refusal" | "invalid_output" | "incomplete" | "rate_limited" | "timeout" | "upstream" | "auth";

export class ModelError extends Error {
  readonly kind: ModelErrorKind;
  constructor(kind: ModelErrorKind, message: string) {
    super(message);
    this.name = "ModelError";
    this.kind = kind;
  }
}
