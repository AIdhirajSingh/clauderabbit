/**
 * OpenAIAdapter: the production ModelAdapter (DESIGN.md section 4).
 *
 * One call shape for every task: Responses API `responses.parse` with a strict
 * json_schema text format built by `zodTextFormat`, `store: false`, the
 * configured reasoning effort, and the scan's AbortSignal. The model id comes
 * from config (`CR_MODEL_ID`, default `gpt-6-luna`), never from call sites.
 * The parsed value is validated again with the caller's zod schema, so a value
 * that reaches the engine always matches the schema.
 */

import OpenAI, { APIConnectionTimeoutError, APIError, APIUserAbortError, AuthenticationError, PermissionDeniedError, RateLimitError } from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import type { ReasoningEffort } from "../config";
import { ModelError, type ModelAdapter, type StructuredRequest, type StructuredResult } from "./adapter";

export interface OpenAIAdapterOptions {
  apiKey: string;
  modelId: string;
  reasoningEffort: ReasoningEffort;
  /** Injected only by tests; production uses the global fetch. */
  fetch?: typeof fetch;
  baseURL?: string;
  maxRetries?: number;
  timeoutMs?: number;
}

export class OpenAIAdapter implements ModelAdapter {
  readonly modelId: string;
  readonly #client: OpenAI;
  readonly #effort: ReasoningEffort;

  constructor(opts: OpenAIAdapterOptions) {
    if (!opts.apiKey) throw new ModelError("auth", "OPENAI_API_KEY is not set");
    this.modelId = opts.modelId;
    this.#effort = opts.reasoningEffort;
    this.#client = new OpenAI({
      apiKey: opts.apiKey,
      maxRetries: opts.maxRetries ?? 1,
      timeout: opts.timeoutMs ?? 20_000,
      ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });
  }

  async structured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    let response;
    try {
      response = await this.#client.responses.parse(
        {
          model: this.modelId,
          input: [
            { role: "system", content: req.system },
            { role: "user", content: req.input },
          ],
          text: { format: zodTextFormat(req.schema, req.schemaName) },
          reasoning: { effort: this.#effort },
          max_output_tokens: req.maxOutputTokens,
          store: false,
        },
        { signal: req.signal },
      );
    } catch (err) {
      throw mapError(err);
    }
    if (response.status === "incomplete") {
      throw new ModelError("incomplete", `model response incomplete: ${response.incomplete_details?.reason ?? "unknown reason"}`);
    }
    for (const item of response.output ?? []) {
      if (item.type === "message") {
        for (const c of item.content) {
          if (c.type === "refusal") throw new ModelError("refusal", `model refused: ${c.refusal.slice(0, 200)}`);
        }
      }
    }
    const rawText = response.output_text ?? "";
    const checked = req.schema.safeParse(response.output_parsed);
    if (!checked.success) {
      throw new ModelError("invalid_output", `model output failed ${req.schemaName} validation: ${checked.error.message.slice(0, 300)}`);
    }
    return {
      value: checked.data,
      usage: {
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
      },
      rawText,
    };
  }
}

function mapError(err: unknown): ModelError {
  if (err instanceof ModelError) return err;
  if (err instanceof APIUserAbortError || err instanceof APIConnectionTimeoutError) {
    return new ModelError("timeout", "model call was aborted or timed out");
  }
  if (err instanceof RateLimitError) return new ModelError("rate_limited", "model provider rate limit reached");
  if (err instanceof AuthenticationError || err instanceof PermissionDeniedError) {
    return new ModelError("auth", "model provider rejected the API key");
  }
  if (err instanceof APIError) return new ModelError("upstream", `model provider returned HTTP ${err.status ?? "error"}`);
  if (err instanceof SyntaxError) return new ModelError("invalid_output", "model output was not valid JSON");
  const name = (err as { name?: string })?.name;
  if (name === "AbortError") return new ModelError("timeout", "model call was aborted");
  return new ModelError("upstream", `model call failed: ${(err as Error)?.message ?? String(err)}`);
}
