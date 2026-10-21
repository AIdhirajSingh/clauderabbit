/**
 * Builds the E2B template `cr-export` that renders MP4 exports
 * (lib/server/export-mp4.ts). It only ever loads our own replay page: no repo
 * code enters it. Playwright's Python image (the playwright version the guest
 * script pins) plus ffmpeg, at the size the export cost is computed for
 * (lib/server/export-mp4/plan.ts EXPORT_VCPU / EXPORT_MEMORY_MB; a test keeps
 * the two in step).
 *
 *   E2B_API_KEY=... node sandbox/e2b/export/build-export.ts
 *   node sandbox/e2b/export/build-export.ts --vercel-hook   (Preview builds only; skips when the template exists)
 */

import { Template, defaultBuildLogger } from "e2b";

export const EXPORT_TEMPLATE_NAME = "cr-export";
export const EXPORT_TEMPLATE_VCPU = 2;
export const EXPORT_TEMPLATE_MEMORY_MB = 2048;
export const PLAYWRIGHT_VERSION = "1.55.0";
export const PLAYWRIGHT_IMAGE = `mcr.microsoft.com/playwright/python:v${PLAYWRIGHT_VERSION}-noble`;

function log(line: string): void {
  console.log(`[cr-export] ${line}`);
}

function template() {
  return Template()
    .fromImage(PLAYWRIGHT_IMAGE)
    .setUser("root")
    .aptInstall(["ffmpeg", "python3-pip"], { noInstallRecommends: true })
    .runCmd([
      // The image carries the browsers for this playwright version, not the Python package.
      `python3 -m pip install -q --break-system-packages playwright==${PLAYWRIGHT_VERSION}`,
      "python3 -m playwright install chromium-headless-shell",
      "mkdir -p /opt/cr-export",
      "ffmpeg -version | head -1",
      "python3 -c 'import playwright'",
    ]);
}

async function main(): Promise<void> {
  const hook = process.argv.includes("--vercel-hook");
  const name = process.env.CR_EXPORT_TEMPLATE?.trim() || EXPORT_TEMPLATE_NAME;
  if (hook && process.env.VERCEL_ENV !== "preview") {
    log(`skip: VERCEL_ENV=${process.env.VERCEL_ENV ?? "unset"} (the export template builds only on Preview)`);
    return;
  }
  if (!process.env.E2B_API_KEY) {
    if (hook) {
      log("skip: E2B_API_KEY is not set for this build");
      return;
    }
    console.error("E2B_API_KEY is not set");
    process.exit(1);
  }
  if (hook && process.env.CR_EXPORT_REBUILD !== "1" && (await Template.exists(name))) {
    log(`skip: template ${name} exists (set CR_EXPORT_REBUILD=1 to rebuild)`);
    return;
  }
  const started = Date.now();
  const info = await Template.build(template(), name, {
    cpuCount: EXPORT_TEMPLATE_VCPU,
    memoryMB: EXPORT_TEMPLATE_MEMORY_MB,
    onBuildLogs: defaultBuildLogger(),
  });
  log(`built ${name} (${EXPORT_TEMPLATE_VCPU} vCPU / ${EXPORT_TEMPLATE_MEMORY_MB} MB) in ${Math.round((Date.now() - started) / 1000)} s, build ${info.buildId}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    // A failed export template must not fail the site build; the export route reports it per job.
    console.error(`[cr-export] build failed: ${e instanceof Error ? e.message : e}`);
    process.exit(process.argv.includes("--vercel-hook") ? 0 : 1);
  });
}
