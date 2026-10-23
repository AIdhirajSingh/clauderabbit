import { ScanBoot } from "@/components/v4/scan/ScanBoot";

/**
 * Shown on navigation before the route's server reply: the paste box opens the scan screen at once, on its first
 * step ("Starting a fresh machine…") with the sandbox booting. The page itself then starts the scan.
 */
export default function Loading() {
  return <ScanBoot />;
}
