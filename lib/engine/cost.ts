/**
 * Per-scan cost ledger. Every fresh scan records:
 *
 *  - Jev tokens (input, output, cached) per check call, priced at the AI
 *    Gateway list price of the configured Jev model;
 *  - Luna tokens (input, output, cached, cache writes) for the one report call,
 *    priced at OpenAI's Standard-tier price of the configured Luna model;
 *  - E2B sandbox seconds of both sandboxes (analysis and detonation, measured
 *    host-side from create to kill), priced per second at the template's size;
 *  - the total in USD and INR at a pinned USD to INR rate.
 *
 * Prices are pinned here with their source and date, read from the providers'
 * published price lists on 2026-10-18. A model with no pinned price is
 * recorded with its tokens and `usd: null`, and the totals are then null:
 * the ledger never prints a number it cannot back.
 */

import type { ModelUsage } from "./model/adapter";
import { SANDBOX_CPU_COUNT, SANDBOX_MEMORY_MB } from "./sandbox/resources";

export interface PriceSheet {
  /** USD per million uncached input tokens. */
  input_per_mtok: number;
  /** USD per million output tokens. */
  output_per_mtok: number;
  /** USD per million cached input tokens; null when the provider does not price cache reads. */
  cached_input_per_mtok: number | null;
  /** USD per million cache-write input tokens; null when not priced separately. */
  cache_write_per_mtok: number | null;
  source: string;
  as_of: string;
}

const PRICE_DATE = "2026-10-18";

/** AI Gateway list prices (GET https://ai-gateway.vercel.sh/v1/models, field `pricing`, USD per token x 1e6). */
export const JEV_PRICES: Readonly<Record<string, PriceSheet>> = {
  "typesafe-ai/jev": {
    input_per_mtok: 0.042,
    output_per_mtok: 0,
    cached_input_per_mtok: null,
    cache_write_per_mtok: null,
    source: "https://ai-gateway.vercel.sh/v1/models typesafe-ai/jev pricing.input 0.000000042, pricing.output 0",
    as_of: PRICE_DATE,
  },
  "typesafe-ai/jev-1.14.0": {
    input_per_mtok: 0.042,
    output_per_mtok: 0,
    cached_input_per_mtok: null,
    cache_write_per_mtok: null,
    source: "https://ai-gateway.vercel.sh/v1/models typesafe-ai/jev-1.14.0 pricing.input 0.000000042, pricing.output 0",
    as_of: PRICE_DATE,
  },
};

/** OpenAI Standard tier, short context (https://developers.openai.com/api/docs/pricing). */
export const LUNA_PRICES: Readonly<Record<string, PriceSheet>> = {
  "gpt-6-luna": {
    input_per_mtok: 0.1,
    output_per_mtok: 0.5,
    cached_input_per_mtok: 0.01,
    cache_write_per_mtok: 0.125,
    source: "https://developers.openai.com/api/docs/pricing Standard, short context: gpt-6-luna input $0.10, cached input $0.01, cache writes $0.125, output $0.50 per 1M tokens",
    as_of: PRICE_DATE,
  },
};

/** E2B per-second compute prices (https://e2b.dev/pricing, Hobby / Pro). */
export const E2B_USD_PER_VCPU_SECOND = 0.000014;
export const E2B_USD_PER_GIB_SECOND = 0.0000045;
export const E2B_PRICE_SOURCE = "https://e2b.dev/pricing: $0.000014/s per vCPU, $0.0000045/s per GiB of memory";

/**
 * USD to INR reference rate pinned for the ledger: the ECB reference rate for
 * 2026-10-16 from https://api.frankfurter.app/latest?from=USD&to=INR
 * (`{"date":"2026-10-16","rates":{"INR":94.96}}`). Cross-check on 2026-10-18:
 * https://open.er-api.com/v6/latest/USD gave 95.075677. `CR_USD_INR` overrides it.
 */
export const DEFAULT_FX = { usd_inr: 94.96, source: "https://api.frankfurter.app/latest?from=USD&to=INR (ECB reference rate)", as_of: "2026-10-16" } as const;

export interface FxRate {
  usd_inr: number;
  source: string;
  as_of: string;
}

export interface ModelLine {
  model: string;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  cache_write_tokens: number;
  usd: number | null;
  price: PriceSheet | null;
}

export interface CallLine {
  model: "jev" | "luna";
  task: string;
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  cache_write_tokens: number;
  usd: number | null;
}

export interface SandboxLine {
  seconds: number;
  vcpu: number;
  memory_gib: number;
  usd_per_second: number;
  usd: number;
  source: string;
  as_of: string;
}

export interface CostLedger {
  version: 1;
  jev: ModelLine;
  luna: ModelLine;
  sandbox: SandboxLine;
  total_usd: number | null;
  total_inr: number | null;
  fx: FxRate;
  calls: CallLine[];
}

/** Round to a nano-dollar so tiny per-call costs survive JSON without float noise. */
export function roundUsd(x: number): number {
  return Math.round(x * 1e9) / 1e9;
}

/** USD for one call: uncached input, cached input and cache writes priced apart, then output. */
export function callUsd(usage: ModelUsage, price: PriceSheet | null): number | null {
  if (!price) return null;
  const cached = Math.max(0, usage.cachedInputTokens);
  const writes = Math.max(0, usage.cacheWriteTokens);
  const uncached = Math.max(0, usage.inputTokens - cached - writes);
  const usd =
    uncached * price.input_per_mtok +
    cached * (price.cached_input_per_mtok ?? price.input_per_mtok) +
    writes * (price.cache_write_per_mtok ?? price.input_per_mtok) +
    Math.max(0, usage.outputTokens) * price.output_per_mtok;
  return roundUsd(usd / 1e6);
}

export function sandboxUsdPerSecond(cpuCount = SANDBOX_CPU_COUNT, memoryMb = SANDBOX_MEMORY_MB): number {
  return roundUsd(cpuCount * E2B_USD_PER_VCPU_SECOND + (memoryMb / 1024) * E2B_USD_PER_GIB_SECOND);
}

function emptyLine(model: string, price: PriceSheet | null): ModelLine {
  return { model, calls: 0, input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, cache_write_tokens: 0, usd: price ? 0 : null, price };
}

/** Collects every model call of one scan; `ledger()` closes it with the sandbox seconds. */
export class CostMeter {
  readonly #jev: ModelLine;
  readonly #luna: ModelLine;
  readonly #calls: CallLine[] = [];
  readonly #fx: FxRate;

  constructor(opts: { jevModel: string; lunaModel: string; fx?: FxRate }) {
    this.#jev = emptyLine(opts.jevModel, JEV_PRICES[opts.jevModel] ?? null);
    this.#luna = emptyLine(opts.lunaModel, LUNA_PRICES[opts.lunaModel] ?? null);
    this.#fx = opts.fx ?? { ...DEFAULT_FX };
  }

  #add(line: ModelLine, which: "jev" | "luna", task: string, usage: ModelUsage): void {
    const usd = callUsd(usage, line.price);
    line.calls += 1;
    line.input_tokens += usage.inputTokens;
    line.output_tokens += usage.outputTokens;
    line.cached_input_tokens += usage.cachedInputTokens;
    line.cache_write_tokens += usage.cacheWriteTokens;
    line.usd = line.usd === null || usd === null ? null : roundUsd(line.usd + usd);
    this.#calls.push({
      model: which,
      task,
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      cached_input_tokens: usage.cachedInputTokens,
      cache_write_tokens: usage.cacheWriteTokens,
      usd,
    });
  }

  recordJev(task: string, usage: ModelUsage): void {
    this.#add(this.#jev, "jev", task, usage);
  }

  recordLuna(task: string, usage: ModelUsage): void {
    this.#add(this.#luna, "luna", task, usage);
  }

  /** Tokens across both models (the daily model-token budget counts these). */
  totalTokens(): number {
    return this.#jev.input_tokens + this.#jev.output_tokens + this.#luna.input_tokens + this.#luna.output_tokens;
  }

  ledger(sandboxSeconds: number, cpuCount = SANDBOX_CPU_COUNT): CostLedger {
    const perSecond = sandboxUsdPerSecond(cpuCount);
    const seconds = Math.max(0, Math.round(sandboxSeconds * 1000) / 1000);
    const sandbox: SandboxLine = {
      seconds,
      vcpu: cpuCount,
      memory_gib: SANDBOX_MEMORY_MB / 1024,
      usd_per_second: perSecond,
      usd: roundUsd(seconds * perSecond),
      source: E2B_PRICE_SOURCE,
      as_of: PRICE_DATE,
    };
    const jev = { ...this.#jev };
    const luna = { ...this.#luna };
    const total = jev.usd === null || luna.usd === null ? null : roundUsd(jev.usd + luna.usd + sandbox.usd);
    return {
      version: 1,
      jev,
      luna,
      sandbox,
      total_usd: total,
      total_inr: total === null ? null : Math.round(total * this.#fx.usd_inr * 1e6) / 1e6,
      fx: { ...this.#fx },
      calls: this.#calls.map((c) => ({ ...c })),
    };
  }
}

/** The ledger a cache hit reports: no model call and no sandbox ran for this request. */
export function cacheHitLedger(opts: { jevModel: string; lunaModel: string; fx?: FxRate }): CostLedger {
  return new CostMeter(opts).ledger(0);
}

/** Read a stored ledger back; anything that is not a version-1 ledger is null. */
export function ledgerFrom(v: unknown): CostLedger | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Partial<CostLedger>;
  if (o.version !== 1 || typeof o.jev !== "object" || typeof o.luna !== "object" || typeof o.sandbox !== "object" || !Array.isArray(o.calls)) return null;
  return o as CostLedger;
}
