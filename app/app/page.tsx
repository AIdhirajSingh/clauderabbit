import type { Metadata } from "next";
import { Header } from "@/components/v4/Header";
import { AppScreen } from "@/components/v4/app/AppScreen";

export const metadata: Metadata = { title: "ClaudeRabbit: scan a GitHub repo or npm package" };

export default function AppPage() {
  return (
    <div style={{ minHeight: "100vh", background: "#000" }}>
      <Header />
      <AppScreen />
    </div>
  );
}
