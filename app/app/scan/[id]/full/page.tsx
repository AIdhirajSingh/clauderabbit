import type { Metadata } from "next";
import { Suspense } from "react";
import { AppShell } from "@/components/cr/app/AppShell";
import { ScanView } from "@/components/cr/app/ScanView";

export const metadata: Metadata = { title: "ClaudeRabbit scan" };

/**
 * Yes on "Keep installing to scan it fully?" links here: a different same-site
 * path, so GPT's web interstitial (defined on the scan page before the click) can
 * show on the navigation. This page plays back the stored full scan or runs one.
 */
export default async function FullScanPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <AppShell>
      <Suspense>
        <ScanView key="full" runId={id} full />
      </Suspense>
    </AppShell>
  );
}
