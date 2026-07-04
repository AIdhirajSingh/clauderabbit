/**
 * GET /api/export/markdown?owner=...&repo=... — downloadable Markdown export
 * of a report (Task 2, report-export features).
 *
 * Reads the SAME latest-report data the public `/[owner]/[repo]` page and the
 * SPA report screen render from (`fetchLatestReport`), then renders it through
 * the pure `reportToMarkdown` (`lib/export-markdown.ts`) so the download always
 * reflects the real report a user is looking at — never a placeholder or a
 * separately-maintained template.
 *
 * No secrets: this route reads through the same public anon Supabase client the
 * SSR report page already uses (reports are public; RLS exposes them to anon).
 */

import { createClient } from "@/lib/supabase/server";
import { fetchLatestReport } from "@/lib/report-fetch";
import { reportToMarkdown } from "@/lib/export-markdown";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Same owner/repo segment charset used across the app (parse-repo.ts /
// attach-forensics / /api/deep) — 1-100 chars of [A-Za-z0-9._-].
const SEGMENT_RE = /^[A-Za-z0-9._-]{1,100}$/;
// Same pattern as app/api/export/pdf/route.ts — never hardcode the published
// domain; fall back to the real local dev origin.
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:2311";

function isCleanSegment(v: string | null): v is string {
  return (
    typeof v === "string" &&
    SEGMENT_RE.test(v) &&
    /[A-Za-z0-9]/.test(v) &&
    v !== "." &&
    v !== ".."
  );
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const owner = url.searchParams.get("owner");
  const repo = url.searchParams.get("repo");

  if (!isCleanSegment(owner) || !isCleanSegment(repo)) {
    return json({ error: "invalid owner or repo" }, 400);
  }

  let supabase;
  try {
    supabase = await createClient();
  } catch {
    return json({ error: "report storage is not configured" }, 500);
  }

  const report = await fetchLatestReport(supabase, owner, repo);
  if (!report) {
    return json({ error: `no report found for ${owner}/${repo}` }, 404);
  }

  const markdown = reportToMarkdown(report, SITE_URL);
  const filename = `${owner}-${repo}-clauderabbit-report.md`;

  return new Response(markdown, {
    status: 200,
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
