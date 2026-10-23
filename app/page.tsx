import type { Metadata } from "next";
import { shownReport } from "@/components/v4/gate/data";
import { Gate } from "@/components/v4/gate/Gate";

/**
 * `/` — the ClaudeRabbit website (Claude Design export project/term/Gate.dc.html).
 * The scanning platform itself lives at `/app`. Every score shown here is a real stored report.
 */

export const metadata: Metadata = {
  title: "ClaudeRabbit",
  description:
    "ClaudeRabbit is a security audit tool that scans open-source repositories and packages to protect the developer and builder community from malware. It is live, free and open source.",
  alternates: { canonical: "/" },
};

export default async function HomePage() {
  const [fixture, lodash, express] = await Promise.all([
    shownReport("AIdhirajSingh", "cr-exfil-test-fixture"),
    shownReport("lodash", "lodash"),
    shownReport("expressjs", "express"),
  ]);
  return <Gate fixture={fixture} scoreCard={lodash} web={express} cli={lodash} />;
}
