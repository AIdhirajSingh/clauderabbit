import type { Metadata } from "next";
import { Header } from "@/components/v4/Header";
import { AppScreen } from "@/components/v4/app/AppScreen";
import { createV2Store } from "@/lib/engine/store";
import { listBoard } from "@/lib/server/board-v2";
import { serverConfig } from "@/lib/server/scan-service";

const TITLE = "Scan a GitHub repo or npm package · ClaudeRabbit";
const DESCRIPTION = "Paste a public GitHub repo or npm package. ClaudeRabbit installs and runs it in a fresh, isolated VM, watches what it does, and returns a 0 to 100 score. The danger board lists the riskiest scans.";

export const metadata: Metadata = {
  title: { absolute: TITLE },
  description: DESCRIPTION,
  alternates: { canonical: "/app" },
  openGraph: { title: TITLE, description: DESCRIPTION, url: "/app", type: "website", siteName: "ClaudeRabbit" },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION },
};

/** The danger board's first page, read on the server so the page paints with its rows; null when the read fails. */
async function firstBoardPage(): Promise<{ rows: never[]; next: number | null } | null> {
  try {
    const page = await listBoard(createV2Store(serverConfig()).db, "all", 0);
    return JSON.parse(JSON.stringify(page));
  } catch {
    return null;
  }
}

export default async function AppPage() {
  const initial = await firstBoardPage();
  return (
    <div style={{ minHeight: "100vh", background: "#000" }}>
      <Header />
      <AppScreen initial={initial} />
    </div>
  );
}
