"use client";

/**
 * /app/scan/new?t=<target>: the paste box opens this at once, before any server reply.
 * It starts the scan here (with the signed-in token when there is one), shows the scan
 * screen in its starting state, then swaps the URL to /app/scan/<runId>; the LiveScan that
 * startScan registers in memory carries the stream on with no gap.
 */

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { startScan } from "@/lib/cr/scan-client";
import { ScanScreen } from "./ScanScreen";

async function accessToken(): Promise<string | null> {
  try {
    const m = await import("@/lib/supabase/client");
    const { data } = await m.createClient().auth.getSession();
    return data.session?.access_token ?? null;
  } catch {
    return null;
  }
}

export function NewScan() {
  const router = useRouter();
  const params = useSearchParams();
  const target = params.get("t")?.trim() ?? "";
  const [error, setError] = useState<string | null>(null);
  // Strict mode runs effects twice; the scan starts once.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (!target) {
      queueMicrotask(() => setError("Nothing to scan."));
      return;
    }
    void (async () => {
      try {
        const { runId } = await startScan(target, await accessToken());
        router.replace(`/app/scan/${runId}`);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Scan failed. Try again.");
      }
    })();
  }, [target, router]);

  return <ScanScreen runId="new" boot={{ error }} />;
}
