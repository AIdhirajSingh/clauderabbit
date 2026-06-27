/**
 * Orbit — the revolving two-column 3D snapshot conveyor. Faithful port of
 * `design-source/Orbit.dc.html`, including its own internal `colA`/`colB` card
 * data (which is distinct from the page-level hero/background card arrays in
 * the prototype's main script — the DC component carried its own set).
 *
 * Props mirror the DC component: `dur` (left column up-marquee duration),
 * `durB` (right column down-marquee duration), `scale`.
 */

import { Snap, type SnapProps } from "./Snap";

const G = "var(--green)";
const B = "var(--blue)";
const A = "var(--amber)";

/** Builds the four faux source lines for a `code` snapshot, exactly as DC's `code(a,b,c)`. */
function code(a: string, b: string, c?: string): SnapProps["lines"] {
  return [
    { n: "1", w: "72%", c: "var(--t4)" },
    { n: "2", w: "92%", c: a },
    { n: "3", w: "54%", c: b },
    { n: "4", w: "80%", c: c || "var(--t5)" },
  ];
}

// Decorative conveyor cards. Repo cards name REAL repos with their real live-scan
// scores/stars (from lib/demo-data); the web/design/code cards are abstract
// illustration only (no repo named, no fabricated verdict score). Colored code
// lines keep the marquee's visual variety without asserting a fake result.
const COL_A: SnapProps[] = [
  { kind: "web", title: "expressjs.com", sub: "Fast, minimalist web framework.", accent: G },
  { kind: "code", title: "router.js", color: B, lines: code(B, "var(--t5)", "var(--t5)") },
  { kind: "design", title: "Design system", sub: "Instrument Serif · Geist" },
  { kind: "repo", title: "pallets/flask", score: "98", color: G, lang: "Python", langColor: B, stars: "71.7k" },
];

const COL_B: SnapProps[] = [
  { kind: "web", title: "Claude Rabbit", sub: "Free open-source malware scanning.", accent: G },
  { kind: "repo", title: "gorilla/mux", score: "95", color: G, lang: "Go", langColor: A, stars: "21.8k" },
  { kind: "code", title: "index.ts", color: G, lines: code(G, "var(--t5)", "var(--blue)") },
  { kind: "web", title: "flask.palletsprojects.com", sub: "Web development, one drop at a time.", accent: B },
];

const FLOATS = ["5.5s", "6.4s", "5.1s", "6.8s"];

/** Normalizes a card list, attaching the per-index float duration and filling defaults. */
function norm(arr: SnapProps[]): Array<SnapProps & { float: string }> {
  return arr.map((c, i) => ({
    ...c,
    float: FLOATS[i % FLOATS.length] ?? "5.5s",
    sub: c.sub || "",
    score: c.score || "",
    color: c.color || G,
    lang: c.lang || "",
    langColor: c.langColor || B,
    stars: c.stars || "",
    accent: c.accent || G,
    lines: c.lines || [],
  }));
}

export interface OrbitProps {
  dur?: string;
  durB?: string;
  scale?: number;
}

/**
 * Vertical gap between conveyor cards. The marquee loops by translating the
 * doubled track `translateY(-50%)`. For the wrap to be SEAMLESS (the first card
 * of copy 2 landing exactly where the first card of copy 1 began), every card —
 * including the last of each copy — must contribute one trailing gap. CSS flex
 * `gap` omits the trailing gap after the final child, which leaves the track
 * height at `2×copy − 1×gap`; `-50%` then undershoots the true copy height by
 * half a gap and the loop visibly jumps. So each card owns its gap via
 * `marginBottom` instead, making the track height an exact `2×copy` and the
 * `-50%` wrap pixel-perfect. The extra trailing margin sits below the fold,
 * hidden by the column's `overflow:hidden` + edge mask.
 */
const CARD_GAP = 20;

export function Orbit({ dur = "26s", durB = "32s", scale = 1 }: OrbitProps) {
  const a = norm(COL_A);
  const b = norm(COL_B);
  const columns = [
    { anim: "marqueeUp", dur, cards: [...a, ...a] },
    { anim: "marqueeDown", dur: durB, cards: [...b, ...b] },
  ];

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        overflow: "hidden",
        perspective: "1900px",
        WebkitMaskImage: "linear-gradient(180deg, transparent, #000 13%, #000 87%, transparent)",
        maskImage: "linear-gradient(180deg, transparent, #000 13%, #000 87%, transparent)",
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: "-8% -4%",
          display: "flex",
          gap: 20,
          justifyContent: "center",
          transform: `scale(${scale}) rotateY(-16deg) rotateX(7deg) rotateZ(2deg)`,
          transformStyle: "preserve-3d",
        }}
      >
        {columns.map((col, ci) => (
          <div key={ci} style={{ flex: 1, maxWidth: 248, minWidth: 200 }}>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                animation: `${col.anim} ${col.dur} linear infinite`,
                willChange: "transform",
              }}
            >
              {col.cards.map((c, i) => (
                <div key={i} style={{ flexShrink: 0, marginBottom: CARD_GAP, animation: `orbCardFloat ${c.float} ease-in-out infinite` }}>
                  <Snap
                    kind={c.kind}
                    title={c.title}
                    sub={c.sub}
                    score={c.score}
                    color={c.color}
                    lang={c.lang}
                    langColor={c.langColor}
                    stars={c.stars}
                    accent={c.accent}
                    lines={c.lines}
                  />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
