import type { Metadata } from "next";
import { Suspense } from "react";
import { AppShell } from "@/components/cr/app/AppShell";
import { ScanView } from "@/components/cr/app/ScanView";

export const metadata: Metadata = { title: "ClaudeRabbit scan" };

export default async function ScanPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <AppShell>
      <Suspense>
        <ScanView runId={id} />
      </Suspense>
    </AppShell>
  );
}
