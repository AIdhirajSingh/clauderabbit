import type { Metadata } from "next";
import { AppShell } from "@/components/cr/app/AppShell";
import { Board } from "@/components/cr/app/Board";

export const metadata: Metadata = { title: "ClaudeRabbit: scan a GitHub repo or npm package" };

export default function AppPage() {
  return (
    <AppShell>
      <Board />
    </AppShell>
  );
}
