/**
 * GET /api/export/pdf?owner=...&repo=...&theme=... — real headless-browser PDF
 * export of a report (Task 1, report-export features).
 *
 * Replaces the old `window.print()` "export" (manual Ctrl+P → Save as PDF) with
 * a genuine server-rendered PDF: this route launches a headless Chromium,
 * navigates to the REAL rendered report page (`/[owner]/[repo]`, the same
 * server-rendered page every visitor and search engine sees), forces the
 * requested theme, waits for full render (fonts + hydration), and captures the
 * entire report as ONE continuous pageless PDF (no default page-break slicing)
 * with backgrounds preserved.
 *
 * Library choice: `puppeteer-core` + `@sparticuz/chromium` in production,
 * plain `puppeteer`'s bundled Chromium locally. This app is deployed to Vercel
 * (serverless functions, read-only filesystem outside `/tmp`, no system Chrome
 * libs) — plain `puppeteer`'s full Chromium download does not run there
 * (verified live: "Could not find Chrome" on the deployed function). Locally,
 * `puppeteer` is still the simplest thing that works (its bundled Chromium
 * needs no extra setup), so we borrow its executable path there instead of
 * requiring a second local Chromium install.
 *
 * Navigating to the real page (rather than rendering the React tree out-of-band)
 * guarantees the PDF is byte-for-byte what a visitor sees — same CSS variables,
 * same score-color logic, same dual-theme rules.
 *
 * No secrets: this only drives a local/loopback browser to a URL this same
 * server serves; no credentials are read or forwarded.
 */

import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";
import type { Browser } from "puppeteer-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** Vercel sets this on every deployment (any environment); absent in local dev. */
const IS_VERCEL = !!process.env.VERCEL;

async function launchBrowser(): Promise<Browser> {
  if (IS_VERCEL) {
    return puppeteer.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: true,
    });
  }
  // Local dev: reuse the full `puppeteer` package's bundled Chromium binary
  // (already a project dependency) via puppeteer-core's launcher, so no
  // separate local Chromium install is required.
  const { default: fullPuppeteer } = await import("puppeteer");
  return puppeteer.launch({
    executablePath: await fullPuppeteer.executablePath(),
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
}

const SEGMENT_RE = /^[A-Za-z0-9._-]{1,100}$/;
const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:2311").replace(/\/+$/, "");

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

/** PDF page width in CSS pixels — matches the report's max content width plus gutters. */
const PDF_WIDTH_PX = 960;
// Puppeteer's page.pdf() wants inches; 96 CSS px per inch is the standard conversion.
const CSS_PX_PER_INCH = 96;

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const owner = url.searchParams.get("owner");
  const repo = url.searchParams.get("repo");
  const theme = url.searchParams.get("theme") === "dark" ? "dark" : "light";

  if (!isCleanSegment(owner) || !isCleanSegment(repo)) {
    return json({ error: "invalid owner or repo" }, 400);
  }

  const targetUrl = `${SITE_URL}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

  let browser: Browser;
  try {
    browser = await launchBrowser();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return json({ error: `could not launch headless browser: ${msg}` }, 500);
  }

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: PDF_WIDTH_PX, height: 1080 });

    // CRITICAL: page.pdf() renders using the "print" CSS media type by default,
    // not "screen". app/globals.css has its OWN @media print block (kept for the
    // harmless Ctrl+P fallback) that forces white paper / light-theme neutrals
    // regardless of data-theme — exactly so a manual browser print looks good on
    // paper. Left alone, that block would silently override our forced dark/light
    // theme here too (both would render identically as forced-white "print"
    // output). Force the "screen" media type so this render uses the REAL live
    // page styles (the actual dark/light theme), not the print stylesheet.
    await page.emulateMediaType("screen");

    // Force the theme BEFORE navigation finishes painting: seed localStorage via
    // an init script (runs before any page script, including the app's no-flash
    // theme-init script in <head>), matching the exact persistence key
    // (`cr-theme`) and `<html data-theme>` attribute the app already uses
    // (see app/layout.tsx's themeInitScript and components/spa/state.tsx's
    // theme toggle). This means the app's OWN theme-init logic picks up the
    // forced theme, rather than us fighting it after the fact.
    await page.evaluateOnNewDocument((forcedTheme: string) => {
      try {
        localStorage.setItem("cr-theme", forcedTheme);
      } catch {
        /* localStorage unavailable; the attribute set below still forces it */
      }
    }, theme);

    const response = await page.goto(targetUrl, { waitUntil: "networkidle0", timeout: 30_000 });
    if (!response || !response.ok()) {
      const status = response?.status() ?? 502;
      return json(
        { error: `report page returned ${status} for ${owner}/${repo}` },
        status === 404 ? 404 : 502,
      );
    }

    // Belt-and-suspenders: explicitly set the attribute too, in case the page's
    // own init script raced evaluateOnNewDocument (it shouldn't — the seeded
    // localStorage value is read by that very script — but this makes the forced
    // theme authoritative regardless of script order).
    await page.evaluate((forcedTheme: string) => {
      document.documentElement.setAttribute("data-theme", forcedTheme);
    }, theme);

    // Wait for the fonts (self-hosted Instrument Serif + Geist, next/font) to be
    // fully loaded so the PDF never captures a fallback-font flash mid-swap.
    await page.evaluate(() => document.fonts.ready);

    // A short settle for the report's entrance animations (riseIn/scoreGlow/etc.,
    // all under 1.2s per app/globals.css) to reach their resting state, so the
    // capture isn't mid-transition (partially-drawn score ring, fading-in cards).
    await new Promise((resolve) => setTimeout(resolve, 700));

    // Measure the full content height so the PDF is ONE continuous page — no
    // default US-Letter/A4 slicing mid-content.
    const contentHeightPx = await page.evaluate(() => document.documentElement.scrollHeight);
    const heightIn = Math.max(contentHeightPx / CSS_PX_PER_INCH, 1);
    const widthIn = PDF_WIDTH_PX / CSS_PX_PER_INCH;

    const pdfBuffer = await page.pdf({
      width: `${widthIn}in`,
      height: `${heightIn}in`,
      printBackground: true,
      pageRanges: "1",
      margin: { top: "0in", bottom: "0in", left: "0in", right: "0in" },
    });

    const filename = `${owner}-${repo}-clauderabbit-report.pdf`;
    return new Response(new Uint8Array(pdfBuffer), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return json({ error: `PDF render failed: ${msg}` }, 500);
  } finally {
    await browser.close().catch(() => {});
  }
}
