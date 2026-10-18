/**
 * Production wiring for runScan (DESIGN.md section 4). Imports only production
 * implementations: Jev on AI Gateway with Vercel OIDC (no key), Luna through
 * the OpenAI adapter (OPENAI_API_KEY), both model ids from config, and the E2B
 * provider. The store is passed in by the caller (the API route builds the v2
 * store on the cr_v2_server connection). Test stand-ins live under tests/ and
 * are never reachable from here.
 */

import { missingKeys, type EngineConfig } from "./config";
import { GatewayJevAdapter } from "./model/jev";
import { OpenAIAdapter } from "./model/openai";
import type { EngineDeps } from "./orchestrator";
import { E2BProvider } from "./sandbox/e2b";
import type { ScanStore } from "./store";
import { EngineError } from "./types";

export function productionDeps(config: EngineConfig, store: ScanStore): EngineDeps {
  const missing = missingKeys(config);
  if (missing.length > 0) {
    // Names only, never values.
    throw new EngineError("internal", `server is missing required configuration: ${missing.join(", ")}`);
  }
  return {
    jev: new GatewayJevAdapter({ modelId: config.jevModelId }),
    luna: new OpenAIAdapter({ apiKey: config.openaiApiKey!, modelId: config.modelId, reasoningEffort: config.reasoningEffort }),
    sandbox: new E2BProvider({ apiKey: config.e2bApiKey!, template: config.e2bTemplate }),
    store,
    fetch: globalThis.fetch.bind(globalThis),
    now: () => Date.now(),
    config,
  };
}
