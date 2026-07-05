/**
 * Real, live verification for an UNRECOGNIZED install-time fetch host — the
 * fix for a genuine false-positive bug class: the static host-allowlist
 * (SOFTWARE_DISTRIBUTION_HOSTS in static-scan.ts) is necessarily a fixed,
 * incomplete list, so ANY legitimate host that simply isn't on it yet reads
 * as a confirmed attack. This already produced a false "Malicious" verdict on
 * this project's own repo (`storage.googleapis.com`, real Google Cloud
 * Storage) and on `opencode.ai` (a real, legitimate open-source CLI's own
 * install domain) — a real credibility risk for any repo this happens to.
 *
 * The fix is a cheap, real, live check — NOT a headless browser (no Puppeteer
 * here: a full browser engine costs real, ongoing compute per check and
 * answers a question this doesn't need). A plain HTTPS HEAD/GET to the host's
 * own root page is the cheapest real signal that actually answers "does this
 * look like a normal, live web service, or something that doesn't even
 * resolve/respond" — which is exactly the gap between a real vendor's install
 * domain and a non-existent/parked/dead C2 host.
 *
 * IMPORTANT — this call MUST only ever run from a context with genuine,
 * unconstrained internet access (this Deno edge function), never from inside
 * the sandbox's own detonation container: the detonated code doesn't choose
 * what we check (only the HOSTNAME STRING it already tried to reach, already
 * captured), so there's no new outbound capability being handed to it, but
 * routing this check through the sandbox's own egress path would need it to
 * bypass the very containment that path exists to enforce.
 *
 * NOTE ON SCOPE: the product also uses a paid search API for OTHER reputation
 * lookups per docs/INFRASTRUCTURE.md's planned architecture (Brave Search),
 * but as of this fix that integration does not exist in deployed code yet
 * (checked directly — no Brave credentials in Supabase secrets, no call site
 * anywhere in this codebase). So there is no second, paid tier to escalate to
 * here yet; this cheap HTTP check is the whole verification layer for now.
 */

const VERIFY_TIMEOUT_MS = 3000;

export interface HostVerification {
  host: string;
  /** true = got a real HTTP response (any status) from the host's own root —
   * a live, responding web service. false = timed out, refused, or DNS/TLS
   * failed entirely — indistinguishable from a non-existent or dead host.
   * null = the check itself could not be attempted (should not happen). */
  legitimate: boolean | null;
  /** Plain-language reason for the report/model prompt. */
  signal: string;
}

/**
 * Live-verify ONE unrecognized host with a cheap HTTPS HEAD (GET fallback if
 * the server rejects HEAD, e.g. 405) to its root path. Never throws — a
 * network failure of any kind is itself the (honest) "not legitimate" signal.
 */
export async function verifyUnrecognizedHost(host: string): Promise<HostVerification> {
  const url = `https://${host}/`;
  const attempt = async (method: "HEAD" | "GET"): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);
    try {
      return await fetch(url, { method, redirect: "follow", signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    let res: Response;
    try {
      res = await attempt("HEAD");
    } catch {
      // Some servers reject HEAD outright (connection-level, not just a 405
      // status) — a real GET is the honest fallback check, not a retry of
      // the same failure.
      res = await attempt("GET");
    }
    return {
      host,
      legitimate: true,
      signal: `responded ${res.status} on a real HTTPS request to its root — a live, reachable web host`,
    };
  } catch (err) {
    return {
      host,
      legitimate: false,
      signal: `no real HTTP response from this host (${(err as Error)?.message ?? "request failed"}) — could not confirm it as a live web service`,
    };
  }
}

/**
 * Verify every unrecognized host from a static scan CONCURRENTLY (each is an
 * independent, cheap request; no reason to serialize) and return a map for
 * O(1) lookup by the caller.
 */
export async function verifyUnrecognizedHosts(hosts: string[]): Promise<Map<string, HostVerification>> {
  const results = await Promise.all(hosts.map((h) => verifyUnrecognizedHost(h)));
  return new Map(results.map((r) => [r.host, r]));
}
