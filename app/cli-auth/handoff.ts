/**
 * The /cli-auth hand-off helpers, kept out of page.tsx (a page file may only
 * export its component). See app/cli-auth/page.tsx for the flow.
 */

export function parseState(raw: string | null): string | null {
  return raw && /^[0-9a-f]{32,128}$/.test(raw) ? raw : null;
}

/** Hand the token to the local CLI in a form POST body: never in a URL. */
export function postToCli(doc: Document, port: number, state: string, token: string): HTMLFormElement {
  const form = doc.createElement("form");
  form.method = "POST";
  form.action = `http://127.0.0.1:${port}/callback`;
  form.style.display = "none";
  for (const [name, value] of [["token", token], ["state", state]] as const) {
    const input = doc.createElement("input");
    input.type = "hidden";
    input.name = name;
    input.value = value;
    form.appendChild(input);
  }
  doc.body.appendChild(form);
  form.submit();
  return form;
}

export function parsePort(raw: string | null): number | null {
  if (!raw || !/^\d{1,5}$/.test(raw)) return null;
  const n = Number.parseInt(raw, 10);
  return n > 0 && n <= 65535 ? n : null;
}
