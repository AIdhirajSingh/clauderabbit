import type { Metadata } from "next";
import { ScanScreenClient } from "@/components/v4/scan/ScanScreenClient";

export const metadata: Metadata = {
  title: { absolute: "Live scan · ClaudeRabbit" },
  description: "A ClaudeRabbit scan running in a fresh, isolated VM: each step, the sandbox, the timeline and the result.",
  robots: { index: false, follow: true },
};

export default async function ScanPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ replay?: string; r?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  // Watch how it happened links to ?replay=1&r=<click time>. A new key mounts a fresh
  // view on every click, so the replay starts from 0.0 s every time.
  const viewKey = sp.replay === "1" ? `replay-${sp.r ?? "0"}` : "live";
  return <ScanScreenClient key={viewKey} runId={id} />;
}
