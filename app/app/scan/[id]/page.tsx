import type { Metadata } from "next";
import { Suspense } from "react";
import { AppShell } from "@/components/cr/app/AppShell";
import { ScanView } from "@/components/cr/app/ScanView";

export const metadata: Metadata = { title: "ClaudeRabbit scan" };

export default async function ScanPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ replay?: string; r?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  // Watch how it happened links to ?replay=1&r=<click time>. A new key mounts a fresh
  // view on every click, so the replay starts from 0.0 s every time instead of the
  // finished view staying on screen.
  const viewKey = sp.replay === "1" ? `replay-${sp.r ?? "0"}` : "live";
  return (
    <AppShell>
      <Suspense>
        <ScanView key={viewKey} runId={id} />
      </Suspense>
    </AppShell>
  );
}
