/**
 * Unit tests for extractDeclaredIntent (scan/index.ts) — the README cross-
 * reference feature: the model is handed the repo's own README as "declared
 * setup/install intent" so it can cross-reference actual flagged behavior
 * against what the project says it does. README is always fetched when
 * present (github.ts selectPaths) but is treated as a doc file by
 * staticScan, so plain prose in it never trips a flagged region on its own —
 * without this extraction it would never reach the model at all.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { extractDeclaredIntent } from "./index.ts";
import type { FetchedFile } from "../_shared/github.ts";

function file(path: string, content: string): FetchedFile {
  return { path, content, truncated: false };
}

Deno.test("extractDeclaredIntent returns the README's content when one was fetched", () => {
  const files = [
    file("README.md", "This project fetches build tools from get.docker.com during setup."),
    file("index.js", "console.log(1)"),
  ];
  const intent = extractDeclaredIntent(files);
  assert(intent?.includes("get.docker.com"));
});

Deno.test("extractDeclaredIntent finds a nested README (README.rst, case-insensitive)", () => {
  const files = [file("docs/README.rst", "Setup: pip install from pypi.org.")];
  const intent = extractDeclaredIntent(files);
  assert(intent?.includes("pypi.org"));
});

Deno.test("extractDeclaredIntent returns null when no README was fetched", () => {
  const files = [file("index.js", "console.log(1)")];
  assertEquals(extractDeclaredIntent(files), null);
});

Deno.test("extractDeclaredIntent returns null for an empty/whitespace-only README", () => {
  const files = [file("README.md", "   \n\n  ")];
  assertEquals(extractDeclaredIntent(files), null);
});

Deno.test("extractDeclaredIntent truncates a very long README with an honest marker", () => {
  const long = "x".repeat(5000);
  const files = [file("README.md", long)];
  const intent = extractDeclaredIntent(files);
  assert(intent !== null);
  assert(intent.length < 5000);
  assert(intent.endsWith("[README truncated for length]"));
});
