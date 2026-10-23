import type { Metadata } from "next";
import { Header } from "@/components/v4/Header";
import { AppScreen } from "@/components/v4/app/AppScreen";

const TITLE = "Scan a GitHub repo or npm package · ClaudeRabbit";
const DESCRIPTION = "Paste a public GitHub repo or npm package. ClaudeRabbit installs and runs it in a fresh, isolated VM, watches what it does, and returns a 0 to 100 score. The danger board lists the riskiest scans.";

export const metadata: Metadata = {
  title: { absolute: TITLE },
  description: DESCRIPTION,
  alternates: { canonical: "/app" },
  openGraph: { title: TITLE, description: DESCRIPTION, url: "/app", type: "website", siteName: "ClaudeRabbit" },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION },
};

export default function AppPage() {
  return (
    <div style={{ minHeight: "100vh", background: "#000" }}>
      <Header />
      <AppScreen />
    </div>
  );
}
