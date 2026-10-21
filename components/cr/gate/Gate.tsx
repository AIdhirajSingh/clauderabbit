import Link from "next/link";
import { Footer } from "../Footer";
import { Mark, MarkDots } from "../Logo";
import { GITHUB_PATH, Orbit } from "../Orbit";
import { GateHeader } from "./GateHeader";
import s from "./gate.module.css";

/**
 * The ClaudeRabbit marketing gate at `/`, ported from the Claude Design export
 * p3/Gate.dc.html. Copy is final and word for word.
 */

const EXT = { target: "_blank", rel: "noopener noreferrer" } as const;
const GITHUB = "https://github.com/AIdhirajSingh/clauderabbit";

type Tone = "" | "ok" | "warn" | "bad";

/** The live scan ticker in the OpenClaw band (doubled for a seamless loop). */
const TICK: [string, string, Tone][] = [
  ["0.0 s", "Fresh machine started", ""],
  ["0.6 s", "Fetched the repo", ""],
  ["2.0 s", "npm install started", ""],
  ["3.1 s", "No malware records in 4 packages", "ok"],
  ["4.2 s", "postinstall script started", "warn"],
  ["4.9 s", "Sent your environment to telemetry-cdn.example", "bad"],
  ["5.0 s", "Fake reply sent. Nothing left the machine.", "ok"],
  ["7.4 s", "Wrote an autostart file outside the project", "bad"],
  ["12.0 s", "Encoded code decoded and run", "warn"],
  ["15.8 s", "Score: 0. Malicious.", "bad"],
];

const DOT: Record<Tone, string | undefined> = {
  "": s.tickDot,
  ok: `${s.tickDot} ${s.tickDotOk}`,
  warn: `${s.tickDot} ${s.tickDotWarn}`,
  bad: `${s.tickDot} ${s.tickDotBad}`,
};

const STEPS: { label: string; color: string }[] = [
  { label: "Fresh, disposable virtual machine", color: "#1B77F3" },
  { label: "Downloads, installs and runs", color: "#121212" },
  { label: "Our forge answers with a fake reply", color: "#FF4829" },
  { label: "Static scanners read the code", color: "#DE37AF" },
  { label: "The score, then the report", color: "#00BF63" },
  { label: "The machine is destroyed", color: "#8A8A8A" },
];

function Arrow() {
  return (
    <svg
      className={s.arrow}
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 12h14m-7-7l7 7l-7 7" />
    </svg>
  );
}

export function Gate() {
  return (
    <div className={s.g}>
      <div className={s.panel}>
        <GateHeader />

        <main id="top">
          {/* Hero */}
          <section aria-label="ClaudeRabbit" className={s.hero}>
            <div className={s.heroRow}>
              <div className={s.heroText}>
                <h1 className={`${s.h1} ${s.blurIn}`}>ClaudeRabbit</h1>
                <p className={`${s.heroCopy} ${s.blurIn} ${s.d1}`}>
                  <span className={s.ink}>
                    ClaudeRabbit is a security audit tool that scans open-source repositories and
                    packages to protect the developer and builder community from malware.
                  </span>{" "}
                  It is live, free and open source.
                </p>
                <div className={`${s.ctas} ${s.blurIn} ${s.d3}`}>
                  <Link href="/app" className={`${s.press} ${s.btnDark} ${s.ctaPrimary}`}>
                    Start scanning
                    <Arrow />
                  </Link>
                  <a href={GITHUB} className={`${s.press} ${s.nl} ${s.ctaGhost}`} {...EXT}>
                    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
                      <path fill="#121212" d={GITHUB_PATH} />
                    </svg>
                    View on GitHub
                  </a>
                </div>
              </div>
              <div className={s.heroVisual}>
                <Orbit />
              </div>
            </div>
          </section>

          {/* The problem + stats */}
          <section aria-label="The problem" className={s.section}>
            <div className={s.wrap}>
              <p className={`${s.lead} ${s.rv}`}>
                GitHub holds 395 million public repositories, and GitHub is only one platform.{" "}
                <span className={s.muted}>
                  There is also npm, on every developer&apos;s laptop, because every piece of
                  software is built from packages. Open source moves overnight.
                </span>{" "}
                A repository can get 100 thousand stars in a day, which means 100 thousand people
                ran it. <span className={s.muted}>Who did its security audit?</span>
              </p>
              <div className={s.stats}>
                <div className={`${s.stat} ${s.rv}`}>
                  <p className={s.statNum}>395M</p>
                  <p className={s.statLabel}>public repositories</p>
                </div>
                <div className={`${s.stat} ${s.rv}`}>
                  <p className={s.statNum}>100K</p>
                  <p className={s.statLabel}>stars in a day</p>
                </div>
                <div className={`${s.stat} ${s.rv}`}>
                  <p className={s.statNum}>450,000</p>
                  <p className={s.statLabel}>new malicious open-source packages</p>
                </div>
              </div>
            </div>
          </section>

          {/* OpenClaw band with the live scan ticker */}
          <section aria-label="OpenClaw" className={s.spaced}>
            <div className={`${s.band} ${s.rv}`}>
              <p className={s.bandCopy}>
                Take OpenClaw, one of the most viral projects on GitHub.{" "}
                <span className={s.bandMuted}>
                  It takes your computer&apos;s permissions and your AI API keys. It was
                  technically invasive, with a real chance of harm, and people still ran it,
                  trusting open source.
                </span>{" "}
                In 2025 alone, over 450,000 new malicious open-source packages appeared.
              </p>
              <div className={s.term}>
                <div className={s.termHead}>
                  <span className={s.liveDot} aria-hidden="true" />
                  <span className={s.termTitle}>clauderabbit/test-fixture</span>
                  <span className={s.spacer} />
                  <span className={s.termScore}>0</span>
                </div>
                <div className={s.termBody}>
                  <ul className={s.ticker} aria-label="Scan log">
                    {[...TICK, ...TICK].map(([t, text, tone], i) => (
                      <li
                        key={i}
                        className={s.tickRow}
                        aria-hidden={i >= TICK.length ? true : undefined}
                      >
                        <span className={s.tickTime}>{t}</span>
                        <span className={DOT[tone]} />
                        <span className={tone === "bad" ? s.tickTextBad : s.tickText}>{text}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          </section>

          {/* How it works */}
          <section id="how" aria-label="How it works" className={s.spaced}>
            <div className={s.row}>
              <div className={`${s.cardWide} ${s.rv}`}>
                <p className={s.body}>
                  <span className={s.strong}>Paste a GitHub link or an npm package.</span>{" "}
                  ClaudeRabbit boots a fresh, disposable virtual machine, downloads the code,
                  installs it and runs it, the same way you would. Every outbound call it makes is
                  answered by our forge with a fake reply and recorded, so nothing real leaves the
                  machine. Static scanners read the code in parallel. Jev, a fast decision model,
                  answers the security questions. A deterministic formula in code turns that
                  evidence into the score. Luna writes the report in plain English. The machine is
                  destroyed after every scan.
                </p>
              </div>
              <div className={`${s.cardVisual} ${s.rv}`}>
                <ol aria-label="One scan" className={s.steps}>
                  {STEPS.map((st, i) => (
                    <li key={st.label} className={s.step} style={{ animationDelay: `${i}s` }}>
                      <span className={s.stepDot} style={{ background: st.color }} />
                      {st.label}
                    </li>
                  ))}
                </ol>
              </div>
            </div>
          </section>

          {/* The score */}
          <section aria-label="The score" className={s.scoreSection}>
            <div className={s.rowReverse}>
              <div className={`${s.cardVisual} ${s.rv}`}>
                <div className={s.scoreCard}>
                  <span className={s.scoreRepo}>lodash/lodash</span>
                  <div className={s.scoreLine}>
                    <span className={s.scoreNum}>74</span>
                    <span className={s.pillCaution}>Caution</span>
                  </div>
                  <div className={s.deduction} style={{ animationDelay: "0.3s" }}>
                    <span className={s.deductionPts}>−16</span>
                    <span>fsevents · package-lock.json</span>
                  </div>
                  <div className={s.deduction} style={{ animationDelay: "0.6s" }}>
                    <span className={s.deductionPts}>−10</span>
                    <span>template() · lodash.js</span>
                  </div>
                </div>
              </div>
              <div className={`${s.cardWide} ${s.rv}`}>
                <p className={s.body}>
                  <span className={s.strong}>The score is well calculated.</span> It shows the
                  evidence behind every point it takes off, and the owner&apos;s reputation is
                  shown separately. ClaudeRabbit never just says &quot;safe&quot;. It tells you
                  what it ran and what it found with a proper safety score.
                </p>
              </div>
            </div>
          </section>

          {/* Web, CLI and MCP */}
          <section aria-label="Web, CLI and MCP" className={s.spaced}>
            <div className={s.wrap}>
              <p className={`${s.lead} ${s.rv}`}>
                It works on the web, in your terminal through the CLI,{" "}
                <span className={s.muted}>and inside AI agents through MCP.</span>
              </p>
              <div className={s.surfaces}>
                <div className={`${s.surfaceWeb} ${s.rv}`}>
                  <span className={s.surfaceLabel}>Web</span>
                  <div className={s.browser}>
                    <div className={s.chrome} aria-hidden="true">
                      <span />
                      <span />
                      <span />
                    </div>
                    <div className={s.urlBar}>
                      <span className={s.typing}>github.com/expressjs/express</span>
                      <span className={s.scanChip}>Scan</span>
                    </div>
                    <div className={s.webResult}>
                      <span className={s.webScore}>90</span>
                      <span className={s.pillLow}>Low risk</span>
                    </div>
                  </div>
                </div>
                <div className={`${s.surfaceCli} ${s.rv}`}>
                  <span className={s.surfaceLabelDark}>CLI</span>
                  <pre className={s.pre}>
                    {"$ npx clauderabbit scan lodash\n"}
                    <span className={s.cliDim}>{"  fresh machine · 10 installed"}</span>
                    {"\n"}
                    <span className={s.cliWarn}>{"  74  Caution"}</span>
                    {"\n"}
                    <span className={s.cliBad}>{"  −16"}</span>
                    {" fsevents\n"}
                    <span className={s.cliBad}>{"  −10"}</span>
                    {" template()"}
                    <span className={s.blink} aria-hidden="true">
                      ▍
                    </span>
                  </pre>
                </div>
                <div className={`${s.surfaceMcp} ${s.rv}`}>
                  <span className={s.surfaceLabel}>MCP</span>
                  <div className={s.bubbleUser}>Add express to my project</div>
                  <div className={s.bubbleTool}>
                    <MarkDots size={16} />
                    clauderabbit · 90 Low risk
                  </div>
                </div>
              </div>
            </div>
          </section>

          {/* Why */}
          <section aria-label="Why" className={s.spaced}>
            <div className={s.wrap}>
              <p className={`${s.lead} ${s.rv}`}>
                If every repository got this audit the moment it launched, developers could stop
                worrying about security and focus on what the product does.{" "}
                <span className={s.muted}>
                  It helps the people who run code and the people who publish it.
                </span>
              </p>
            </div>
          </section>

          {/* Cost */}
          <section aria-label="Cost" className={s.spaced}>
            <div className={s.row}>
              <div className={`${s.costCard} ${s.rv}`}>
                <div className={`${s.costBlob} ${s.driftB}`} />
                <p className={s.costNum}>$0.001</p>
              </div>
              <div className={`${s.costText} ${s.rv}`}>
                <p className={s.body}>
                  <span className={s.strong}>
                    A deep scan, with the server, the AI, the web, the sandbox and the network
                    included, costs us about $0.001.
                  </span>{" "}
                  That is what makes it free for everyone, everywhere. ClaudeRabbit runs on
                  programmatic advertising. All it needs is your support and awareness.
                </p>
                <p className={s.signoff}>That is ClaudeRabbit.</p>
              </div>
            </div>
          </section>

          {/* Closing card */}
          <section aria-label="Start" className={s.startSection}>
            <div className={s.start}>
              <div className={`${s.startBlob} ${s.startBlobA} ${s.driftA}`} />
              <div className={`${s.startBlob} ${s.startBlobB} ${s.driftB}`} />
              <div className={`${s.startBlob} ${s.startBlobC} ${s.driftC}`} />
              <span className={s.markTile}>
                <Mark size={42} />
              </span>
              <h2 className={s.h2}>Cybersecurity for builders.</h2>
              <Link href="/app" className={`${s.press} ${s.btnDark} ${s.ctaClose}`}>
                Start scanning
                <Arrow />
              </Link>
            </div>
          </section>
        </main>
      </div>

      <Footer />
    </div>
  );
}
