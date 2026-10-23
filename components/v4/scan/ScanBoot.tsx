"use client";

import { Suspense } from "react";
import { ScanScreen } from "./ScanScreen";

/** The scan screen in its boot state, with nothing fetched or started: shown the instant the route changes. */
export function ScanBoot() {
  return (
    <Suspense>
      <ScanScreen runId="new" boot={{ error: null }} />
    </Suspense>
  );
}
