import type { Metadata } from "next";
import { Gate } from "@/components/cr/gate/Gate";

/**
 * `/` — the ClaudeRabbit marketing gate (Claude Design export p3/Gate.dc.html).
 * The scanning platform itself lives at `/app`.
 */

export const metadata: Metadata = {
  title: "ClaudeRabbit",
  description:
    "ClaudeRabbit is a security audit tool that scans open-source repositories and packages to protect the developer and builder community from malware. It is live, free and open source.",
};

export default function HomePage() {
  return <Gate />;
}
