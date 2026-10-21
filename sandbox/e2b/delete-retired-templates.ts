/**
 * Deletes E2B templates 2.0 no longer uses. Runs in Preview builds only
 * (`--vercel-hook`), where E2B_API_KEY already lives; it never runs locally with
 * a pulled key. Idempotent: a template that is already gone is skipped.
 *
 * Retired: `cr-export` (MP4 export, removed in round 2 of the 2.0 UI).
 */

import { Template } from "e2b";

export const RETIRED_TEMPLATES = ["cr-export"] as const;

function log(line: string): void {
  console.log(`[cr-retire] ${line}`);
}

async function main(): Promise<void> {
  if (process.env.VERCEL_ENV !== "preview") {
    log(`skip: VERCEL_ENV=${process.env.VERCEL_ENV ?? "unset"} (retires templates only on Preview)`);
    return;
  }
  const key = process.env.E2B_API_KEY;
  if (!key) {
    log("skip: E2B_API_KEY is not set for this build");
    return;
  }
  const api = `https://api.${process.env.E2B_DOMAIN || "e2b.app"}`;
  for (const name of RETIRED_TEMPLATES) {
    if (!(await Template.exists(name))) {
      log(`${name}: already gone`);
      continue;
    }
    const res = await fetch(`${api}/templates/${encodeURIComponent(name)}`, { method: "DELETE", headers: { "X-API-Key": key } });
    const gone = !(await Template.exists(name));
    log(`${name}: DELETE ${res.status}, exists after: ${!gone}`);
  }
}

main().catch((e) => {
  // Retiring a template must never fail the site build.
  console.error(`[cr-retire] failed: ${e instanceof Error ? e.message : e}`);
});
