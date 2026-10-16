/**
 * Test-only fetch double: routes by exact URL (or a predicate) to canned
 * responses and records every call. Never imported by production code.
 */

export interface FakeRoute {
  match: string | ((url: string, init?: RequestInit) => boolean);
  respond: (url: string, init?: RequestInit) => Response | Promise<Response>;
}

export interface FakeFetch {
  fetch: typeof fetch;
  calls: Array<{ url: string; init?: RequestInit }>;
}

export function fakeFetch(routes: FakeRoute[]): FakeFetch {
  const calls: FakeFetch["calls"] = [];
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    for (const r of routes) {
      const ok = typeof r.match === "string" ? r.match === url : r.match(url, init);
      if (ok) return r.respond(url, init);
    }
    return new Response("no route", { status: 599 });
  };
  return { fetch: impl as typeof fetch, calls };
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

export function bytes(data: Uint8Array, status = 200): Response {
  return new Response(new Uint8Array(data), { status });
}
