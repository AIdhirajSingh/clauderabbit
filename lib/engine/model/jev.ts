/**
 * Jev: the checker. Every model-judged check in a scan (install surface,
 * flagged regions, docs) is one `experimental_decide` call to the decision
 * model `typesafe-ai/jev` on Vercel AI Gateway.
 *
 * Auth is Vercel OIDC only. The token comes from `@vercel/oidc`
 * (`x-vercel-oidc-token` request header on Vercel, `VERCEL_OIDC_TOKEN` in a
 * local shell after `vercel env pull`) and is handed to the gateway provider as
 * the bearer with `ai-gateway-auth-method: oidc`. `AI_GATEWAY_API_KEY` is never
 * read: the provider only falls back to that variable when no `apiKey` option
 * is given, and this adapter always gives the OIDC token. No token means the
 * call fails closed with a `ModelError("auth")` that says so; there is no key
 * fallback.
 *
 * Jev answers typed questions about one shared state: `choice` (one option of a
 * fixed set, with a probability per option) and `boolean` (P(true)). Every
 * answer is validated against the question it answers (zod, plus the SDK's own
 * distribution checks), so a value that reaches the engine always matches the
 * question. Jev never writes text and never emits the score.
 */

import { createGateway, experimental_decide } from "ai";
import { getVercelOidcToken } from "@vercel/oidc";
import { z } from "zod";
import { ModelError, type ModelUsage } from "./adapter";


export type JevTask = "check.install" | "check.flagged" | "check.docs";

export type JevQuestion =
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "boolean"; instructions: string; criteria?: { true?: string; false?: string } };

export type JevAnswer =
  | { type: "choice"; choice: string; probabilities: Record<string, number> | null }
  | { type: "boolean"; probability: number };

export interface JevRequest {
  task: JevTask;
  /** The shared state every question is judged against. */
  state: string;
  questions: Record<string, JevQuestion>;
  signal: AbortSignal;
}

export interface JevResult {
  answers: Record<string, JevAnswer>;
  usage: ModelUsage;
  /** The model id the gateway reports it served. */
  servedModelId: string;
}

export interface JevAdapter {
  readonly modelId: string;
  decide(req: JevRequest): Promise<JevResult>;
}

/** Jev's request limit is 32,000 tokens for the state plus the longest question; keep the state well under. */
export const JEV_STATE_MAX_CHARS = 60_000;
/** Questions per request (each check sends one per file or window). */
export const JEV_MAX_QUESTIONS = 24;

const prob = z.number().min(0).max(1);
const choiceAnswer = z.object({ type: z.literal("choice"), choice: z.string(), probabilities: z.record(z.string(), prob).optional() });
const booleanAnswer = z.object({ type: z.literal("boolean"), probability: prob });

/** Validate one raw answer against the question it answers. Throws ModelError("invalid_output"). */
export function checkedAnswer(id: string, q: JevQuestion, raw: unknown): JevAnswer {
  if (q.type === "choice") {
    const a = choiceAnswer.safeParse(raw);
    if (!a.success) throw new ModelError("invalid_output", `Jev answer ${id} is not a choice answer: ${a.error.message.slice(0, 200)}`);
    const options = Object.keys(q.criteria);
    if (!options.includes(a.data.choice)) throw new ModelError("invalid_output", `Jev answer ${id} chose "${a.data.choice.slice(0, 40)}", which is not one of ${options.join(", ")}`);
    const p = a.data.probabilities ?? null;
    if (p) {
      for (const k of Object.keys(p)) if (!options.includes(k)) throw new ModelError("invalid_output", `Jev answer ${id} has a probability for an unknown option`);
    }
    return { type: "choice", choice: a.data.choice, probabilities: p };
  }
  const b = booleanAnswer.safeParse(raw);
  if (!b.success) throw new ModelError("invalid_output", `Jev answer ${id} is not a boolean answer: ${b.error.message.slice(0, 200)}`);
  return { type: "boolean", probability: b.data.probability };
}

export function checkedAnswers(questions: Record<string, JevQuestion>, raw: Record<string, unknown>): Record<string, JevAnswer> {
  const out: Record<string, JevAnswer> = {};
  for (const [id, q] of Object.entries(questions)) {
    if (!(id in raw)) throw new ModelError("invalid_output", `Jev returned no answer for ${id}`);
    out[id] = checkedAnswer(id, q, raw[id]);
  }
  return out;
}

export interface GatewayJevAdapterOptions {
  modelId: string;
  /** Returns the Vercel OIDC token. Defaults to `@vercel/oidc` getVercelOidcToken. Tests inject. */
  oidcToken?: () => Promise<string>;
  /** Injected only by tests; production uses the global fetch. */
  fetch?: typeof fetch;
  baseURL?: string;
  maxRetries?: number;
}

const NO_OIDC =
  "Jev needs a Vercel OIDC token for AI Gateway (the x-vercel-oidc-token request header on Vercel, or VERCEL_OIDC_TOKEN from `vercel env pull` locally). No token was available, so the check did not run; AI Gateway API keys are not used.";

export class GatewayJevAdapter implements JevAdapter {
  readonly modelId: string;
  readonly #oidcToken: () => Promise<string>;
  readonly #fetch: typeof fetch | undefined;
  readonly #baseURL: string | undefined;
  readonly #maxRetries: number;

  constructor(opts: GatewayJevAdapterOptions) {
    if (!opts.modelId) throw new ModelError("auth", "Jev model id is not set");
    this.modelId = opts.modelId;
    this.#oidcToken = opts.oidcToken ?? (() => getVercelOidcToken());
    this.#fetch = opts.fetch;
    this.#baseURL = opts.baseURL;
    this.#maxRetries = opts.maxRetries ?? 1;
  }

  async #token(): Promise<string> {
    let token: string;
    try {
      token = await this.#oidcToken();
    } catch {
      throw new ModelError("auth", NO_OIDC);
    }
    if (typeof token !== "string" || token.trim().length === 0) throw new ModelError("auth", NO_OIDC);
    return token.trim();
  }

  async decide(req: JevRequest): Promise<JevResult> {
    const ids = Object.keys(req.questions);
    if (ids.length === 0) throw new ModelError("invalid_output", "a Jev check needs at least one question");
    if (ids.length > JEV_MAX_QUESTIONS) throw new ModelError("invalid_output", `a Jev check sends at most ${JEV_MAX_QUESTIONS} questions`);
    const token = await this.#token();
    const gateway = createGateway({
      apiKey: token,
      headers: { "ai-gateway-auth-method": "oidc" },
      ...(this.#baseURL ? { baseURL: this.#baseURL } : {}),
      ...(this.#fetch ? { fetch: this.#fetch } : {}),
    });
    let result;
    try {
      result = await experimental_decide({
        model: gateway.decision(this.modelId),
        state: req.state.length > JEV_STATE_MAX_CHARS ? req.state.slice(0, JEV_STATE_MAX_CHARS) : req.state,
        questions: req.questions,
        maxRetries: this.#maxRetries,
        abortSignal: req.signal,
      });
    } catch (err) {
      throw mapJevError(err);
    }
    return {
      answers: checkedAnswers(req.questions, result.answers as Record<string, unknown>),
      usage: {
        inputTokens: result.usage.inputTokens ?? 0,
        outputTokens: result.usage.outputTokens ?? 0,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
      },
      servedModelId: result.response.modelId ?? this.modelId,
    };
  }
}

/** Gateway and SDK errors to ModelError kinds. Messages never carry the token. */
export function mapJevError(err: unknown): ModelError {
  if (err instanceof ModelError) return err;
  const e = err as { name?: string; message?: string; statusCode?: number; lastError?: unknown };
  if (e?.name === "AI_RetryError" && e.lastError) return mapJevError(e.lastError);
  const message = String(e?.message ?? err).replace(/Bearer\s+\S+/gi, "Bearer [redacted]").slice(0, 400);
  if (e?.name === "AbortError" || e?.name === "TimeoutError") return new ModelError("timeout", "Jev call was aborted or timed out");
  if (/credit card|payment|billing|insufficient (?:credits|funds)/i.test(message) || e?.statusCode === 402) {
    return new ModelError("billing", `AI Gateway refused the Jev call for billing: ${message}`);
  }
  if (e?.name === "GatewayAuthenticationError" || e?.statusCode === 401) return new ModelError("auth", `AI Gateway rejected the OIDC token: ${message.split("\n")[0]}`);
  if (e?.name === "GatewayRateLimitError" || e?.statusCode === 429) return new ModelError("rate_limited", "AI Gateway rate limit reached for Jev");
  if (e?.name === "GatewayModelNotFoundError") return new ModelError("upstream", `AI Gateway does not serve the Jev model: ${message}`);
  if (e?.name === "AI_TypeValidationError" || e?.name === "AI_InvalidResponseDataError") {
    return new ModelError("invalid_output", `Jev answer failed validation: ${message}`);
  }
  return new ModelError("upstream", `Jev call failed${e?.statusCode ? ` (HTTP ${e.statusCode})` : ""}: ${message}`);
}
