/**
 * Production wiring for runScan (DESIGN.md section 4). Imports only production
 * implementations: Jev on AI Gateway with Vercel OIDC (no key), Luna through
 * the OpenAI adapter (OPENAI_API_KEY), both model ids from config, and the E2B
 * provider. The store is passed in by the caller (the API route builds the v2
 * store on the cr_v2_server connection). Test stand-ins live under tests/ and
 * are never reachable from here.
 */

import { missingKeys, type EngineConfig } from "./config";
import type { ModelAdapter, StructuredRequest, StructuredResult } from "./model/adapter";
import type { JevAdapter, JevRequest, JevResult } from "./model/jev";
import type { EngineDeps } from "./orchestrator";
import type { SandboxCreateOptions, SandboxProvider, SandboxSession } from "./sandbox/provider";
import type { ScanStore } from "./store";
import { EngineError } from "./types";

/**
 * The three SDKs (ai + gateway, openai, e2b) load on first use, not when the
 * route module loads: a cache hit on a cold function instance never calls a
 * model or starts a VM, so it no longer pays their import time.
 */
function once<T>(load: () => Promise<T>): () => Promise<T> {
  let p: Promise<T> | null = null;
  return () => (p ??= load().catch((err) => {
    p = null;
    throw err;
  }));
}

class LazyJev implements JevAdapter {
  readonly modelId: string;
  readonly #get: () => Promise<JevAdapter>;
  constructor(modelId: string) {
    this.modelId = modelId;
    this.#get = once(async () => new (await import("./model/jev")).GatewayJevAdapter({ modelId }));
  }
  async decide(req: JevRequest): Promise<JevResult> {
    return (await this.#get()).decide(req);
  }
}

class LazyLuna implements ModelAdapter {
  readonly modelId: string;
  readonly #get: () => Promise<ModelAdapter>;
  constructor(config: EngineConfig) {
    this.modelId = config.modelId;
    this.#get = once(async () => new (await import("./model/openai")).OpenAIAdapter({ apiKey: config.openaiApiKey!, modelId: config.modelId, reasoningEffort: config.reasoningEffort }));
  }
  async structured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    return (await this.#get()).structured(req);
  }
}

class LazySandbox implements SandboxProvider {
  readonly template: string;
  readonly #get: () => Promise<SandboxProvider>;
  constructor(config: EngineConfig) {
    this.template = config.e2bTemplate;
    this.#get = once(async () => new (await import("./sandbox/e2b")).E2BProvider({ apiKey: config.e2bApiKey!, template: config.e2bTemplate }));
  }
  async create(opts: SandboxCreateOptions): Promise<SandboxSession> {
    return (await this.#get()).create(opts);
  }
}

export function productionDeps(config: EngineConfig, store: ScanStore): EngineDeps {
  const missing = missingKeys(config);
  if (missing.length > 0) {
    // Names only, never values.
    throw new EngineError("internal", `server is missing required configuration: ${missing.join(", ")}`);
  }
  return {
    jev: new LazyJev(config.jevModelId),
    luna: new LazyLuna(config),
    sandbox: new LazySandbox(config),
    store,
    fetch: globalThis.fetch.bind(globalThis),
    now: () => Date.now(),
    config,
  };
}
