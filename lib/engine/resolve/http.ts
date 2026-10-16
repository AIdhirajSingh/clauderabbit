/**
 * Bounded HTTP helpers shared by the resolvers: a fetch with a deadline that
 * also honors the scan's AbortSignal, a body reader that stops at a byte cap,
 * and Subresource Integrity verification.
 */

import { createHash } from "node:crypto";
import { EngineError } from "../types";

export const USER_AGENT = "ClaudeRabbit-Scanner/2.0 (+https://clauderabbit.in)";

export type FetchLike = typeof fetch;

export async function fetchWithDeadline(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("deadline")), timeoutMs);
  const onAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new EngineError("timeout", `request to ${new URL(url).host} exceeded ${timeoutMs} ms`);
    }
    throw new EngineError("upstream", `request to ${new URL(url).host} failed: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/** Read a body into memory, throwing `too_large` past `cap` bytes. */
export async function readCapped(res: Response, cap: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length") ?? "NaN");
  if (Number.isFinite(declared) && declared > cap) {
    await res.body?.cancel();
    throw new EngineError("too_large", `response is ${declared} bytes, over the ${cap} byte cap`);
  }
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      total += value.length;
      if (total > cap) {
        await reader.cancel();
        throw new EngineError("too_large", `response exceeded the ${cap} byte cap`);
      }
      chunks.push(value);
    }
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

export type SriAlgo = "sha512" | "sha384" | "sha256" | "sha1";

const SRI_STRENGTH: Record<string, number> = { sha512: 3, sha384: 2, sha256: 1 };

/**
 * Verify bytes against an SRI string (`sha512-<base64>` and friends; several
 * space-separated hashes allowed, the strongest one is used). Returns the
 * algorithm used; throws `integrity` on mismatch or when no usable hash exists.
 */
export function verifySri(bytes: Uint8Array, integrity: string): SriAlgo {
  const candidates = integrity
    .trim()
    .split(/\s+/)
    .map((tok) => /^(sha512|sha384|sha256)-([A-Za-z0-9+/]+={0,2})(\?.*)?$/.exec(tok))
    .filter((m): m is RegExpExecArray => m !== null)
    .sort((a, b) => (SRI_STRENGTH[b[1]!] ?? 0) - (SRI_STRENGTH[a[1]!] ?? 0));
  const best = candidates[0];
  if (!best) throw new EngineError("integrity", "no usable SRI hash (sha512, sha384 or sha256) was provided");
  const algo = best[1] as "sha512" | "sha384" | "sha256";
  const digest = createHash(algo).update(bytes).digest("base64");
  if (digest !== best[2]) {
    throw new EngineError("integrity", `bytes do not match the published ${algo} integrity`);
  }
  return algo;
}

/** Legacy npm `dist.shasum` (sha1 hex) check, used only when no SRI string exists. */
export function verifySha1Hex(bytes: Uint8Array, shasum: string): SriAlgo {
  if (!/^[0-9a-f]{40}$/i.test(shasum)) throw new EngineError("integrity", "shasum is not a sha1 hex digest");
  const digest = createHash("sha1").update(bytes).digest("hex");
  if (digest.toLowerCase() !== shasum.toLowerCase()) {
    throw new EngineError("integrity", "bytes do not match the published sha1 shasum");
  }
  return "sha1";
}

export function sha512Sri(bytes: Uint8Array): string {
  return "sha512-" + createHash("sha512").update(bytes).digest("base64");
}
