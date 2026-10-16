/**
 * Operator tarball target (DESIGN.md section 4): an https URL plus the sha512
 * or sha256 SRI the operator expects (PyPI publishes sha256 digests only). Only reachable with a valid CR_OPERATOR_KEY; the
 * caller enforces that before this runs. Used to scan an artifact that is not on
 * GitHub or npm (the labeled set's removed versions, a vendor drop).
 */

import { EngineError } from "../types";
import { USER_AGENT, fetchWithDeadline, readCapped, sha512Sri, verifySri, type FetchLike } from "./http";

export interface OperatorTarballSpec {
  url: string;
  integrity: string;
  label: string;
}

const LABEL_RE = /^[A-Za-z0-9@._/-]{1,120}$/;

export function validateOperatorTarball(spec: OperatorTarballSpec): void {
  let u: URL;
  try {
    u = new URL(spec.url);
  } catch {
    throw new EngineError("invalid_target", "operator tarball url is not a URL");
  }
  if (u.protocol !== "https:") throw new EngineError("invalid_target", "operator tarball url must be https");
  if (u.username || u.password) throw new EngineError("invalid_target", "operator tarball url must not carry credentials");
  const integrity = spec.integrity.trim();
  if (!/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity) && !/^sha256-[A-Za-z0-9+/]{43}=$/.test(integrity)) {
    throw new EngineError("invalid_target", "operator tarball integrity must be a sha512 or sha256 SRI string");
  }
  if (!LABEL_RE.test(spec.label)) throw new EngineError("invalid_target", "operator tarball label has invalid characters");
}

export async function fetchOperatorTarball(
  spec: OperatorTarballSpec,
  ctx: { fetch: FetchLike; timeoutMs: number; signal?: AbortSignal },
  maxBytes: number,
): Promise<{ bytes: Uint8Array; sha512: string }> {
  validateOperatorTarball(spec);
  const res = await fetchWithDeadline(ctx.fetch, spec.url, { headers: { "User-Agent": USER_AGENT } }, ctx.timeoutMs, ctx.signal);
  if (!res.ok) {
    await res.body?.cancel();
    throw new EngineError(res.status === 404 ? "not_found" : "upstream", `operator tarball returned HTTP ${res.status}`);
  }
  const bytes = await readCapped(res, maxBytes);
  verifySri(bytes, spec.integrity);
  return { bytes, sha512: sha512Sri(bytes) };
}
