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
 * Library choice: `puppeteer-core` + `@sparticuz/chromium` in production, and
 * the machine's OWN already-installed Chrome/Chromium locally (via puppeteer-core,
 * see resolveLocalChromePath). This app is deployed to Vercel (serverless
 * functions, read-only filesystem outside `/tmp`, no system Chrome libs) — a
 * bundled full-Chromium download does not run there (verified live: "Could not
 * find Chrome" on the deployed function), which is why production ships the
 * Lambda-tuned @sparticuz/chromium binary. Locally we deliberately do NOT depend
 * on plain `puppeteer` just to download a SECOND Chromium: that install-time
 * download (from storage.googleapis.com) is wasted bytes on any machine that
 * already has a browser AND is exactly the kind of install-time network fetch our
 * own sandbox blocks — bundling it made this very repo fail to install cleanly
 * under containment. Point at the system browser instead (or PUPPETEER_EXECUTABLE_PATH).
 *
 * Navigating to the real page (rather than rendering the React tree out-of-band)
 * guarantees the PDF is byte-for-byte what a visitor sees — same CSS variables,
 * same score-color logic, same dual-theme rules.
 *
 * No secrets: this only drives a local/loopback browser to a URL this same
 * server serves; no credentials are read or forwarded.
 */

import { existsSync } from "node:fs";
import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";
import type { Browser } from "puppeteer-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** Vercel sets this on every deployment (any environment); absent in local dev. */
const IS_VERCEL = !!process.env.VERCEL;

/**
 * Local-dev only: the path to a real, already-installed Chrome/Chromium on this machine.
 * Production never calls this (it uses @sparticuz/chromium). An explicit env override wins;
 * otherwise probe the standard install locations for the host OS. We intentionally avoid a
 * bundled `puppeteer` Chromium download here — see the file header for why (waste + it is the
 * exact install-time network fetch our own sandbox containment blocks).
 */
function resolveLocalChromePath(): string {
  const fromEnv =
    process.env.PUPPETEER_EXECUTABLE_PATH ||
    process.env.CHROME_PATH ||
    process.env.CHROME_BIN;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;

  const pf = process.env["ProgramFiles"] || "C:\\Program Files";
  const pfx86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const localApp = process.env.LOCALAPPDATA;
  const candidates = [
    // Windows
    `${pf}\\Google\\Chrome\\Application\\chrome.exe`,
    `${pfx86}\\Google\\Chrome\\Application\\chrome.exe`,
    localApp ? `${localApp}\\Google\\Chrome\\Application\\chrome.exe` : "",
    `${pf}\\Microsoft\\Edge\\Application\\msedge.exe`,
    // macOS
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    // Linux
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
  ].filter(Boolean);

  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  throw new Error(
    "no local Chrome/Chromium found for PDF export — install Chrome or set " +
      "PUPPETEER_EXECUTABLE_PATH to a Chromium binary (production is unaffected; it uses @sparticuz/chromium).",
  );
}

// Anti-abuse: each request launches a headless Chromium — an expensive, memory-heavy
// operation. Without a bound, a flood of /api/export/pdf requests exhausts the function's
// memory/CPU (a real resource-exhaustion DoS). Cap concurrent renders PER INSTANCE (Fluid
// Compute reuses instances, so this bounds each instance's simultaneous browsers); a request
// over the cap is rejected fast with 429 + Retry-After instead of piling on another browser.
const MAX_CONCURRENT_PDF = 2;
let pdfInFlight = 0;

async function launchBrowser(): Promise<Browser> {
  if (IS_VERCEL) {
    return puppeteer.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: true,
    });
  }
  // Local dev: drive the machine's already-installed Chrome/Chromium via
  // puppeteer-core (no bundled `puppeteer` Chromium download — see the file header).
  return puppeteer.launch({
    executablePath: resolveLocalChromePath(),
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

  // Reject over the per-instance concurrency cap BEFORE spending anything on a browser.
  if (pdfInFlight >= MAX_CONCURRENT_PDF) {
    return new Response(
      JSON.stringify({ error: "PDF export is busy — please retry in a moment." }),
      { status: 429, headers: { "Content-Type": "application/json", "Retry-After": "5" } },
    );
  }

  const targetUrl = `${SITE_URL}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

  pdfInFlight++;
  let browser: Browser;
  try {
    browser = await launchBrowser();
  } catch (e) {
    pdfInFlight--;
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
    pdfInFlight--;
  }
}
