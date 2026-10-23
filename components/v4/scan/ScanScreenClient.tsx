"use client";

import dynamic from "next/dynamic";
import { Suspense } from "react";

/**
 * The scan screen renders in the browser only. It is a live view of a run (noindex), and a direct load of
 * /app/scan/<id> did not hydrate its server HTML; rendering it on the client alone opens a stored run and a live run alike.
 * /app/scan/new starts a scan from the paste box and then moves to the run's own id.
 */
const ScanScreen = dynamic(() => import("./ScanScreen").then((m) => m.ScanScreen), { ssr: false });
const NewScan = dynamic(() => import("./NewScan").then((m) => m.NewScan), { ssr: false });

export function ScanScreenClient({ runId }: { runId: string }) {
  return <Suspense>{runId === "new" ? <NewScan /> : <ScanScreen key={runId} runId={runId} />}</Suspense>;
}
