import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePort, parseState, postToCli } from "./handoff.ts";

// A minimal DOM: enough to see what the page submits, and where.
function fakeDocument() {
  const appended: unknown[] = [];
  let submitted: { action: string; method: string; fields: Record<string, string> } | null = null;
  const doc = {
    createElement(tag: string) {
      const el: Record<string, unknown> & { children: Record<string, string>[] } = { tag, style: {}, children: [] };
      el.appendChild = (c: Record<string, string>) => el.children.push(c);
      el.submit = () => {
        submitted = { action: el.action as string, method: el.method as string, fields: Object.fromEntries(el.children.map((c) => [c.name, c.value])) };
      };
      return el;
    },
    body: { appendChild: (x: unknown) => appended.push(x) },
  };
  return { doc: doc as unknown as Document, submitted: () => submitted, appended };
}

test("the token goes to the CLI in a POST body, never in the URL", () => {
  const f = fakeDocument();
  const token = `cr_cli_${"ab".repeat(32)}`;
  postToCli(f.doc, 54321, "c".repeat(48), token);
  const s = f.submitted();
  assert.ok(s);
  assert.equal(s.method, "POST");
  assert.equal(s.action, "http://127.0.0.1:54321/callback");
  assert.doesNotMatch(s.action, /token|cr_cli_/);
  assert.deepEqual(s.fields, { token, state: "c".repeat(48) });
});

test("port and state are validated before any hand-off", () => {
  assert.equal(parsePort("54321"), 54321);
  for (const bad of [null, "0", "70000", "1e3", "http://evil"]) assert.equal(parsePort(bad), null);
  assert.equal(parseState("a".repeat(48)), "a".repeat(48));
  for (const bad of [null, "", "short", "Z".repeat(48), `${"a".repeat(48)}&x=1`]) assert.equal(parseState(bad), null);
});
