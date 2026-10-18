/**
 * Build the scan template on E2B and print its id (DESIGN.md section 3.1).
 *
 *   E2B_API_KEY=... node sandbox/e2b/build.ts            build now (always)
 *   node sandbox/e2b/build.ts --vercel-hook              Vercel build step
 *
 * `--vercel-hook` is what `npm run vercel-build` runs before `next build`. It
 * builds only on a Vercel Preview build (VERCEL_ENV=preview) that has
 * E2B_API_KEY, and only when the template content changed: every build is tagged
 * with a content tag (sha256 over the template definition, the guest scripts, the
 * rules, the mirror seed and the VM size), and a build is skipped when the
 * `default` tag already points at the build carrying the current content tag.
 * Production (VERCEL_ENV=production) and local builds never build a template.
 * The key is read from the environment by the SDK and never printed.
 *
 * Optional: CR_E2B_TEMPLATE (template name, default clauderabbit-detonate).
 * Prints `template_id=<id> build_id=<id> name=<name> tag=<content tag>` on
 * success and exits 1 on any build or smoke failure.
 */

import { Template, defaultBuildLogger } from "e2b";
import { SANDBOX_CPU_COUNT, SANDBOX_MEMORY_MB } from "../../lib/engine/sandbox/resources.ts";
import { templateContentTag } from "./content-tag.ts";
import { TEMPLATE_NAME_DEFAULT, buildTemplate } from "./template.ts";

function log(line: string): void {
  console.log(`[cr-template] ${line}`);
}

/** True when `default` already points at the build tagged with `tag`. */
async function upToDate(name: string, tag: string): Promise<boolean> {
  if (!(await Template.exists(name))) return false;
  const tags = await Template.getTags(name);
  const content = tags.find((t) => t.tag === tag);
  const def = tags.find((t) => t.tag === "default");
  log(`existing tags: ${tags.map((t) => `${t.tag}->${t.buildId}`).join(", ") || "none"}`);
  return Boolean(content && def && content.buildId === def.buildId);
}

async function main(): Promise<void> {
  const hook = process.argv.includes("--vercel-hook");
  const name = process.env.CR_E2B_TEMPLATE?.trim() || TEMPLATE_NAME_DEFAULT;
  const tag = templateContentTag();

  if (hook) {
    const env = process.env.VERCEL_ENV;
    if (env !== "preview") {
      log(`skip: VERCEL_ENV=${env ?? "unset"} (templates build only on Preview)`);
      return;
    }
    if (!process.env.E2B_API_KEY) {
      log("skip: E2B_API_KEY is not set for this Preview build");
      return;
    }
  } else if (!process.env.E2B_API_KEY) {
    console.error("E2B_API_KEY is not set");
    process.exit(1);
  }

  log(`template ${name}, content tag ${tag}, ${SANDBOX_CPU_COUNT} vCPU / ${SANDBOX_MEMORY_MB} MB`);
  if (hook && (await upToDate(name, tag))) {
    log(`up to date: ${name}:default is the ${tag} build; nothing to build`);
    return;
  }

  const t0 = Date.now();
  const info = await Template.build(buildTemplate(), name, {
    tags: [tag],
    cpuCount: SANDBOX_CPU_COUNT,
    memoryMB: SANDBOX_MEMORY_MB,
    onBuildLogs: defaultBuildLogger(),
  });
  // Point the bare name (tag `default`, what Sandbox.create resolves) at this build.
  const assigned = await Template.assignTags(`${name}:${tag}`, "default");
  log(`built in ${Math.round((Date.now() - t0) / 1000)} s; default -> ${assigned.buildId}`);
  console.log(`template_id=${info.templateId} build_id=${info.buildId} name=${info.name} tag=${tag}`);
}

main().catch((err: unknown) => {
  console.error(`[cr-template] failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
