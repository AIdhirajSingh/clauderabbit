/**
 * Unit tests for `lib/export-markdown.ts` — the pure Markdown report renderer.
 *
 * These guard the two CLAUDE.md rails that carry over into every export
 * surface: a verdict is never rendered as a bare "Safe", and reputation
 * signals stay in a structurally distinct section from code/behavior signals
 * (never blended into one list). They also exercise the forensics path (an
 * escalated/deep report) and the no-forensics path (a pure static read), since
 * the two must render different, non-overlapping content.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { reportToMarkdown } from "../lib/export-markdown.ts";
import { REPOS } from "../lib/demo-data.ts";
import type { Report } from "../lib/types.ts";

// A real, live-scan-captured report with no forensics (pure static read) and a
// low-severity code finding — exercises the common path against real data.
const flask = REPOS["pallets/flask"];
if (!flask) throw new Error("fixture missing: pallets/flask");

const SITE_URL = "http://localhost:2311";

test("reportToMarkdown renders title, score, and verdict for a static-read report", () => {
  const md = reportToMarkdown(flask, SITE_URL);
  assert.match(md, /^# pallets\/flask — Claude Rabbit safety report/);
  assert.match(md, /\*\*Score:\*\* 98 \/ 100/);
  assert.match(md, /\*\*Verdict:\*\* Trusted/);
  assert.match(md, /Static read/);
});

test("reportToMarkdown separates reputation signals from code & behavior signals into distinct sections", () => {
  const md = reportToMarkdown(flask, SITE_URL);
  const repIdx = md.indexOf("## Reputation signals");
  const codeIdx = md.indexOf("## Code & behavior signals");
  assert.ok(repIdx > -1, "expected a Reputation signals section");
  assert.ok(codeIdx > -1, "expected a Code & behavior signals section");
  assert.ok(repIdx < codeIdx, "reputation section should precede code/behavior section");

  // The reputation section (between its heading and the next) must not contain
  // the code-finding title, and vice versa — the two must not blend content.
  const repSection = md.slice(repIdx, codeIdx);
  const codeSection = md.slice(codeIdx, md.indexOf("## Per-package scoring"));
  assert.doesNotMatch(repSection, /Hardcoded local loopback/);
  assert.match(codeSection, /Hardcoded local loopback/);
  assert.doesNotMatch(codeSection, /Pallets organization|Public repos/);
});

test("reportToMarkdown never renders a bare 'Safe' verdict, even for a hypothetical bare-Safe row", () => {
  const bareSafeReport: Report = {
    ...flask,
    verdict: "Safe",
  };
  const md = reportToMarkdown(bareSafeReport, SITE_URL);
  // enforceVerdict (via buildReportView) must have replaced the bare "Safe" with
  // a score-banded, honest verdict word.
  assert.doesNotMatch(md, /\*\*Verdict:\*\* Safe\b/);
  assert.match(md, /\*\*Verdict:\*\* (Trusted|Likely safe|Caution|High risk)/);
});

test("reportToMarkdown includes a clean-state note when there are no risky items", () => {
  const md = reportToMarkdown({ ...flask, risky: [] }, SITE_URL);
  assert.match(md, /No risky items found/);
});

test("reportToMarkdown omits the forensics section for a report with no forensic record", () => {
  const md = reportToMarkdown(flask, SITE_URL);
  assert.doesNotMatch(md, /## What running it revealed/);
});

// A synthetic escalated report exercising the forensics path: caught attack,
// named network attempt, credential reads, and a captured payload.
const escalatedReport: Report = {
  id: "evil/repo",
  owner: "evil",
  name: "repo",
  score: 5,
  verdict: "Malicious",
  cached: false,
  deep: true,
  summary: "We ran it in the sandbox and caught it attempting exfiltration.",
  ownerHistory: {
    handle: "evil",
    name: "Evil Corp",
    age: "3 days",
    established: false,
    repos: 1,
    note: "Brand-new account.",
  },
  reputation: {
    stars: "0",
    forks: "0",
    sentiment: "No community signal yet",
    sentScore: 5,
  },
  stats: { loc: "12 KB", packages: 1, stars: "0", created: "3 days ago" },
  packages: [{ name: "evil-pkg", score: 2, note: "Obfuscated install script." }],
  risky: [
    { title: "Obfuscated install hook", severity: "high", kind: "code", detail: "base64-encoded payload in postinstall." },
    { title: "New owner account", severity: "med", kind: "rep", detail: "Account created 3 days ago." },
  ],
  logs: [{ ch: "Clone", kind: "ok", lines: ["Cloned evil/repo at commit abc123"] }],
  commit_sha: "abc123",
  forensics: {
    schema: "claude-rabbit/forensic-record@1",
    generated_at: "2026-07-01T00:00:00Z",
    target: "evil/repo",
    what_it_ran: {
      project_type: "Node.js",
      install_command: "npm install",
      run_command: "node index.js",
      auto_build_succeeded: true,
      ran_without_crash: true,
      build_exit_code: 0,
      run_exit_code: 0,
    },
    network_intent: {
      attempts: [
        {
          intended_host: "exfil.evil-c2.example",
          sni: null,
          http_host_header: null,
          dest_port: 443,
          transport: "tcp",
          tls: true,
          tls_handshake: "failed",
          http_method: "POST",
          http_path: "/collect",
          http_headers: null,
          would_be_payload_b64: Buffer.from("secret=stolen-token").toString("base64"),
          payload_len: 20,
          captured_at: "2026-07-01T00:00:01Z",
        },
      ],
      attempt_count: 1,
      intended_destinations: [{ host: "exfil.evil-c2.example", intended_ips: ["203.0.113.5"] }],
      geolocations: [{ host: "exfil.evil-c2.example", country: "Nowhereland", city: "Nowhere", org: "Bad ISP" }],
    },
    in_vm_behavior: {
      high_value_credential_reads: 2,
      high_value_credential_reads_succeeded: 1,
      credential_reads_detail: [
        { path: "/home/user/.aws/credentials", succeeded: true, high_value: true },
        { path: "/home/user/.ssh/id_rsa", succeeded: false, high_value: true },
      ],
      suspicious_binaries: [],
      files_dropped_count: 1,
      files_dropped: ["/tmp/payload.sh"],
      high_cpu: false,
      run_cpu_cores_busy: 0.42,
      process_exec_count: 3,
    },
    payload_analysis: { decoded_payloads: [], ai_intent_summary: null, ai_model: null, ai_analysis_error: null },
    containment: {
      external_monitor_saw_egress: true,
      in_vm_saw_egress: true,
      no_real_packet_reached_destination: true,
      containment_notes: "Every outbound attempt was intercepted at the forge; nothing reached the real internet.",
      egress_control_probe: "blocked",
    },
    verdict: {
      dynamic_score: 5,
      score_color: "red",
      one_word: "Malicious",
      headline: "Caught attempting credential exfiltration",
      code_behavior_findings: [
        { signal: "Obfuscated payload", severity: "high", detail: "Base64-encoded exfil payload in postinstall hook." },
      ],
      captured_network_intent: ["exfil.evil-c2.example"],
      egress_intercepted_count: 1,
      attack_egress_intercepted: true,
      not_verified: [],
    },
    honesty: { possibly_dormant_unverified: false, notes: [] },
  },
};

test("reportToMarkdown includes the forensics section for an escalated report that actually ran", () => {
  const md = reportToMarkdown(escalatedReport, SITE_URL);
  assert.match(md, /## What running it revealed/);
  assert.match(md, /### What it ran/);
  assert.match(md, /npm install/);
  assert.match(md, /### Network intent/);
  assert.match(md, /exfil\.evil-c2\.example/);
  assert.match(md, /### In-VM behavior/);
  assert.match(md, /### Containment proof/);
  assert.match(md, /\.aws\/credentials/);
});

test("reportToMarkdown renders the captured payload as inert, fenced code, never delivered", () => {
  const md = reportToMarkdown(escalatedReport, SITE_URL);
  assert.match(md, /Attempted exfil payload \(captured, never delivered\)/);
  assert.match(md, /```\nsecret=stolen-token\n```/);
});

test("reportToMarkdown keeps forensics network/behavior findings out of the reputation section", () => {
  const md = reportToMarkdown(escalatedReport, SITE_URL);
  const repIdx = md.indexOf("## Reputation signals");
  const codeIdx = md.indexOf("## Code & behavior signals");
  const repSection = md.slice(repIdx, codeIdx);
  assert.doesNotMatch(repSection, /exfil\.evil-c2\.example/);
  assert.doesNotMatch(repSection, /Obfuscated install hook/);
});

test("reportToMarkdown escapes Markdown-significant characters in freeform text", () => {
  const withMarkdownChars: Report = {
    ...flask,
    summary: "This repo does `rm -rf /` and has a # heading and | pipe | chars and *asterisks*.",
  };
  const md = reportToMarkdown(withMarkdownChars, SITE_URL);
  // The raw special characters should be escaped, not interpreted as Markdown syntax.
  // (A "#" that isn't at the start of a line is not heading syntax, so it needs no escaping.)
  assert.match(md, /\\`rm -rf \/\\`/);
  assert.match(md, /a # heading/);
  assert.match(md, /\\\*asterisks\\\*/);
});

test("reportToMarkdown includes end-to-end logs as a distinct section", () => {
  const md = reportToMarkdown(flask, SITE_URL);
  assert.match(md, /## End-to-end logs/);
  assert.match(md, /### Clone/);
  assert.match(md, /### Reputation/);
});

test("reportToMarkdown's auto-published line uses the real caller-supplied origin, never a hardcoded domain", () => {
  const md = reportToMarkdown(flask, "https://example-preview-deploy.test");
  assert.match(md, /Auto-published at example-preview-deploy\.test\/pallets\/flask/);
  assert.doesNotMatch(md, /claude-rabbit\.dev/);
});
