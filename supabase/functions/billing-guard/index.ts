/**
 * billing-guard — automatic switch from the generator (credit) route back to
 * direct Vertex the moment ClaudeRabbit spends real money.
 *
 * Wiring: a Cloud Billing budget on ClaudeRabbit's project (after-credit spend,
 * display name CR_GUARD_BUDGET_NAME) publishes programmatic notifications to a
 * Pub/Sub topic; a PUSH subscription delivers them here with a Google-signed OIDC
 * token minted for the service account CR_GUARD_PUSH_SA. When the notification's
 * costAmount exceeds CR_GUARD_THRESHOLD (default 1, in the billing currency), this
 * writes "vertex" to storage object cr-config/model-backend-override, which every
 * scan reads before its model call (scan/index.ts killSwitchBackend). Budget email
 * alerts go to the billing account's admins from Cloud Billing itself.
 *
 * Auth: Pub/Sub requests must carry a valid Google OIDC JWT (issuer
 * accounts.google.com, audience CR_GUARD_AUDIENCE, email CR_GUARD_PUSH_SA,
 * email_verified). Operator ops (status / reset) require x-cr-probe-key ==
 * CR_PROBE_KEY. Nothing else is accepted. The guard only ever switches TO vertex;
 * switching back is a deliberate operator reset.
 *
 * Deploy with --no-verify-jwt: the caller is Pub/Sub, not a Supabase user.
 */
import { createClient } from "@supabase/supabase-js";
import { createRemoteJWKSet, jwtVerify } from "jose";

const BUCKET = "cr-config";
const OBJECT = "model-backend-override";
const GOOGLE_JWKS = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

function db() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("server not configured");
  return createClient(url, key, { auth: { persistSession: false } });
}

async function writeOverride(value: "vertex" | "none"): Promise<void> {
  const client = db();
  // Idempotent: "already exists" is the normal case after the first write.
  await client.storage.createBucket(BUCKET, { public: false }).catch(() => undefined);
  const { error } = await client.storage.from(BUCKET).upload(
    OBJECT,
    new Blob([value], { type: "text/plain" }),
    { upsert: true, contentType: "text/plain" },
  );
  if (error) throw new Error(`override write failed: ${error.message}`);
}

async function readOverride(): Promise<string> {
  const { data } = await db().storage.from(BUCKET).download(OBJECT);
  return data ? (await data.text()).trim() : "none";
}

function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** True when the request carries a valid Pub/Sub OIDC token for our push SA. */
async function verifiedPubSub(req: Request): Promise<boolean> {
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const audience = Deno.env.get("CR_GUARD_AUDIENCE");
  const pushSa = Deno.env.get("CR_GUARD_PUSH_SA");
  if (!token || !audience || !pushSa) return false;
  try {
    const { payload } = await jwtVerify(token, GOOGLE_JWKS, {
      issuer: ["https://accounts.google.com", "accounts.google.com"],
      audience,
    });
    return payload.email === pushSa && payload.email_verified === true;
  } catch {
    return false;
  }
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  // Operator ops: status / reset.
  const probeKey = Deno.env.get("CR_PROBE_KEY") ?? "";
  if (probeKey.length >= 32 && timingSafeEqual(req.headers.get("x-cr-probe-key") ?? "", probeKey)) {
    const body = await req.json().catch(() => ({})) as { op?: string };
    if (body.op === "reset") {
      await writeOverride("none");
      console.log("billing-guard: override reset by operator");
    }
    return json({ override: await readOverride().catch(() => "unreadable") });
  }

  if (!(await verifiedPubSub(req))) return json({ error: "unauthorized" }, 401);

  // From here the sender is verified: always 2xx so Pub/Sub does not redeliver.
  let n: Record<string, unknown> = {};
  try {
    const push = await req.json() as { message?: { data?: string } };
    n = JSON.parse(atob(push.message?.data ?? ""));
  } catch {
    console.error("billing-guard: unparseable notification");
    return json({ ok: false, reason: "unparseable" });
  }

  const expected = Deno.env.get("CR_GUARD_BUDGET_NAME") ?? "clauderabbit-credit-guard";
  if (n.budgetDisplayName !== expected) return json({ ok: true, ignored: "other budget" });

  const threshold = Number(Deno.env.get("CR_GUARD_THRESHOLD") ?? "1");
  const cost = Number(n.costAmount);
  if (Number.isFinite(cost) && cost > threshold) {
    await writeOverride("vertex");
    console.error(
      "billing-guard TRIPPED: after-credit spend %s %s > %s — model backend forced to vertex",
      cost,
      n.currencyCode ?? "",
      threshold,
    );
    return json({ ok: true, tripped: true, cost });
  }
  return json({ ok: true, tripped: false, cost });
});
