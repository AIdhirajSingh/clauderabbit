/**
 * Build the scan template on E2B and print its id (DESIGN.md section 3.1).
 *
 *   E2B_API_KEY=... node sandbox/e2b/build.ts
 *
 * Optional: CR_E2B_TEMPLATE (template name, default clauderabbit-detonate).
 * Prints `template_id=<id> build_id=<id> name=<name>` on success and exits 1 on
 * any build or smoke failure. Set CR_E2B_TEMPLATE in Vercel to the same name.
 */

import { Template, defaultBuildLogger } from "e2b";
import { SANDBOX_CPU_COUNT, SANDBOX_MEMORY_MB } from "../../lib/engine/sandbox/resources.ts";
import { TEMPLATE_NAME_DEFAULT, buildTemplate } from "./template.ts";

async function main(): Promise<void> {
  if (!process.env.E2B_API_KEY) {
    console.error("E2B_API_KEY is not set");
    process.exit(1);
  }
  const name = process.env.CR_E2B_TEMPLATE?.trim() || TEMPLATE_NAME_DEFAULT;
  const info = await Template.build(buildTemplate(), name, {
    cpuCount: SANDBOX_CPU_COUNT,
    memoryMB: SANDBOX_MEMORY_MB,
    onBuildLogs: defaultBuildLogger(),
  });
  console.log(`template_id=${info.templateId} build_id=${info.buildId} name=${info.name}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
