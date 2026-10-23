"use client";

import Link from "next/link";
import { useState } from "react";
import type { ShownReport } from "./data";
import { TONE } from "./tone";

/**
 * The Web / CLI / MCP tabs (Gate.dc.html #mcp). The scores shown are the real stored reports for
 * expressjs/express (Web, MCP) and lodash/lodash (CLI); a tab with no stored report shows no score.
 */

type Tab = "web" | "cli" | "mcp";
const TABS: [Tab, string][] = [["web", "Web"], ["cli", "CLI"], ["mcp", "MCP"]];

export function Surfaces({ web, cli }: { web: ShownReport | null; cli: ShownReport | null }) {
  const [tab, setTab] = useState<Tab>("web");
  return (
    <div className="card" style={{ marginTop: "56px" }}>
      <div className="card-h" role="tablist" aria-label="Where ClaudeRabbit runs" style={{ justifyContent: "flex-start", gap: "4px", padding: "8px" }}>
        {TABS.map(([id, label]) => {
          const on = id === tab;
          return (
            <button key={id} type="button" role="tab" id={`surface-${id}`} aria-selected={on} aria-controls="surface-panel" onClick={() => setTab(id)} className="btn btn-sm" style={{ height: "32px", padding: "0 12px", borderRadius: "10px", border: `1px solid ${on ? "rgba(255,255,255,0.12)" : "transparent"}`, background: on ? "rgba(255,255,255,0.08)" : "transparent", color: on ? "#F0F0F0" : "#A1A1A1" }}>
              {label}
            </button>
          );
        })}
      </div>
      <div id="surface-panel" role="tabpanel" aria-labelledby={`surface-${tab}`} style={{ minHeight: "260px", padding: "28px" }}>
        {tab === "web" && (
          <>
            <div style={{ maxWidth: "560px", display: "flex", gap: "8px" }}><span className="mono" style={{ flex: 1, minWidth: "0", height: "48px", display: "flex", alignItems: "center", padding: "0 16px", borderRadius: "14px", border: "1px solid rgba(255,255,255,0.12)", background: "#000", fontSize: "14px" }}>github.com/{web?.slug ?? "expressjs/express"}</span><Link href="/app" className="btn btn-p">Scan</Link></div>
            {web && (
              <div style={{ marginTop: "28px", display: "flex", alignItems: "baseline", gap: "12px" }}><span style={{ fontSize: "48px", fontWeight: 500, letterSpacing: "-0.05em", lineHeight: 1 }}>{web.score}</span><span className={`pill ${web.pill}`}>{web.verdict}</span></div>
            )}
          </>
        )}
        {tab === "cli" && (
          <div className="mono code">
            <div><span className="faint">$</span> npx clauderabbit scan {cli ? cli.slug.split("/")[1] : "lodash"}</div>
            <div className="faint">fresh machine{cli && cli.installed > 0 ? ` · ${cli.installed} installed` : ""}</div>
            {cli && (
              <>
                <div style={{ marginTop: "10px" }}>{cli.score}  <span style={{ color: TONE[cli.pill] }}>{cli.verdict}</span></div>
                {cli.findings.map((f) => (
                  <div key={f.title}><span style={{ color: TONE[f.severity === "low" ? "p-warn" : "p-bad"] }}>{f.severity}</span>  {f.title}</div>
                ))}
              </>
            )}
            <span className="caret" aria-hidden="true" />
          </div>
        )}
        {tab === "mcp" && (
          <>
            <div style={{ maxWidth: "520px", display: "flex", flexDirection: "column", gap: "12px" }}>
              <div style={{ alignSelf: "flex-end", padding: "10px 14px", borderRadius: "14px", background: "#161616", fontSize: "15px" }}>Add express to my project</div>
              {web && (
                <div style={{ padding: "12px 14px", borderRadius: "14px", border: "1px solid rgba(255,255,255,0.1)", fontSize: "15px" }}><span className="mono dim">clauderabbit</span> · {web.score} <span className={`pill ${web.pill}`} style={{ marginLeft: "4px" }}>{web.verdict}</span></div>
              )}
            </div>
            <div style={{ marginTop: "28px", display: "flex", flexWrap: "wrap", gap: "20px" }}>
              <div style={{ flex: "1 1 260px", minWidth: "0" }}><div className="faint" style={{ fontSize: "13px" }}>MCP server</div><div className="mono" style={{ marginTop: "8px", height: "44px", display: "flex", alignItems: "center", padding: "0 14px", borderRadius: "12px", border: "1px solid rgba(255,255,255,0.12)", background: "#000", fontSize: "14px" }}>https://clauderabbit.in/mcp</div></div>
              <div style={{ flex: "2 1 340px", minWidth: "0" }}><div className="faint" style={{ fontSize: "13px" }}>mcp.json</div><div className="mono code" style={{ marginTop: "8px", padding: "10px 14px", borderRadius: "12px", border: "1px solid rgba(255,255,255,0.08)", background: "#000", whiteSpace: "pre" }}>{"{\n  "}<span className="s">&quot;mcpServers&quot;</span>{": {\n    "}<span className="s">&quot;clauderabbit&quot;</span>{": { "}<span className="s">&quot;url&quot;</span>{": "}<span className="s">&quot;https://clauderabbit.in/mcp&quot;</span>{" }\n  }\n}"}</div></div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
