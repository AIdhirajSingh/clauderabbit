/**
 * Snap — a single decorative "snapshot" card used in the Orbit conveyor and the
 * site-wide 3D card background. Faithful port of `design-source/Snap.dc.html`.
 *
 * Four kinds (web / code / design / repo) selected by the `kind` prop; default
 * is `repo` (matching the DC `k = this.props.kind || 'repo'`). Colors are kept
 * as `var(--x)` strings exactly as the design feeds them.
 */

/** A single faux source line inside a `code` snapshot. */
export interface SnapCodeLine {
  n: string;
  w: string;
  c: string;
}

export interface SnapProps {
  kind?: "web" | "code" | "design" | "repo";
  title?: string;
  sub?: string;
  score?: string;
  color?: string;
  lang?: string;
  langColor?: string;
  stars?: string;
  accent?: string;
  lines?: SnapCodeLine[];
}

const STAR_PATH =
  "M8 .25l2.06 4.78 5.19.45-3.94 3.41 1.18 5.07L8 11.42 3.51 14l1.18-5.1L.75 5.48l5.19-.45z";

/** The GitHub mark used on the repo card. */
const GITHUB_PATH =
  "M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.7-.01-1.27-2.23.41-2.7-.94-2.7-.94-.36-.93-.89-1.18-.89-1.18-.73-.5.06-.49.06-.49.8.06 1.23.83 1.23.83.71 1.23 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.28.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z";

export function Snap({
  kind = "repo",
  title = "",
  sub = "",
  score = "",
  color = "var(--green)",
  lang = "",
  langColor = "var(--blue)",
  stars = "",
  accent = "var(--green)",
  lines = [],
}: SnapProps) {
  return (
    <div
      style={{
        width: "100%",
        background: "var(--paper)",
        border: "1px solid var(--line)",
        borderRadius: 16,
        boxShadow: "var(--shadow)",
        overflow: "hidden",
      }}
    >
      {kind === "web" && (
        <>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "10px 12px",
              borderBottom: "1px solid var(--line)",
              background: "var(--glass2)",
            }}
          >
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--line3)" }} />
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--line2)" }} />
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--line2)" }} />
            <span
              style={{
                marginLeft: 8,
                fontSize: 11,
                color: "var(--t4)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {title}
            </span>
          </div>
          <div style={{ padding: 18 }}>
            <div
              style={{
                height: 60,
                borderRadius: 10,
                background: `linear-gradient(135deg, ${accent}, transparent 85%)`,
                marginBottom: 14,
                position: "relative",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  background: `radial-gradient(80px 80px at 78% 30%, ${accent}, transparent 70%)`,
                  opacity: 0.7,
                }}
              />
            </div>
            <div className="serif" style={{ fontSize: 19, color: "var(--t1)", lineHeight: 1.1, marginBottom: 10 }}>
              {sub}
            </div>
            <div style={{ height: 7, width: "88%", borderRadius: 4, background: "var(--s3)", marginBottom: 7 }} />
            <div style={{ height: 7, width: "62%", borderRadius: 4, background: "var(--s2)" }} />
          </div>
        </>
      )}

      {kind === "code" && (
        <>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
              padding: "9px 13px",
              borderBottom: "1px solid var(--line)",
              background: "var(--glass2)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 9, minWidth: 0 }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--line3)" }} />
              <span
                style={{
                  fontSize: 11,
                  color: "var(--t3)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {title}
              </span>
            </div>
            <span
              className="tnum"
              style={{
                fontSize: 11,
                fontWeight: 600,
                color,
                border: `1px solid ${color}`,
                borderRadius: 7,
                padding: "2px 7px",
                flexShrink: 0,
              }}
            >
              {score}
            </span>
          </div>
          <div style={{ padding: "15px 16px", display: "flex", flexDirection: "column", gap: 8 }}>
            {lines.map((ln, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 9 }}>
                <span
                  className="tnum"
                  style={{ fontSize: 10, color: "var(--t5)", width: 12, flexShrink: 0, textAlign: "right" }}
                >
                  {ln.n}
                </span>
                <span style={{ height: 7, borderRadius: 3, width: ln.w, background: ln.c, opacity: 0.82 }} />
              </div>
            ))}
          </div>
        </>
      )}

      {kind === "design" && (
        <div style={{ padding: "16px 17px" }}>
          <div
            style={{
              fontSize: 10,
              color: "var(--t4)",
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              marginBottom: 13,
            }}
          >
            {title}
          </div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 14 }}>
            <span className="serif" style={{ fontSize: 34, color: "var(--t1)", lineHeight: 0.9 }}>
              Aa
            </span>
            <span style={{ fontSize: 12, color: "var(--t3)" }}>{sub}</span>
          </div>
          <div style={{ display: "flex", gap: 7, marginBottom: 13 }}>
            <span style={{ width: 26, height: 26, borderRadius: 7, background: "var(--green)" }} />
            <span style={{ width: 26, height: 26, borderRadius: 7, background: "var(--blue)" }} />
            <span style={{ width: 26, height: 26, borderRadius: 7, background: "var(--amber)" }} />
            <span style={{ width: 26, height: 26, borderRadius: 7, background: "var(--red)" }} />
            <span style={{ width: 26, height: 26, borderRadius: 7, background: "var(--gold)" }} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ height: 6, width: "90%", borderRadius: 3, background: "var(--s3)" }} />
            <div style={{ height: 6, width: "64%", borderRadius: 3, background: "var(--s2)" }} />
          </div>
        </div>
      )}

      {kind === "repo" && (
        <div style={{ padding: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 12 }}>
            <svg width="15" height="15" viewBox="0 0 16 16" fill="var(--t3)" style={{ flexShrink: 0 }} aria-hidden="true">
              <path d={GITHUB_PATH} />
            </svg>
            <span
              style={{
                fontSize: 12.5,
                color: "var(--t1)",
                fontWeight: 500,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                flex: 1,
                minWidth: 0,
              }}
            >
              {title}
            </span>
            <span
              className="tnum"
              style={{
                fontSize: 11,
                fontWeight: 600,
                color,
                border: `1px solid ${color}`,
                borderRadius: 7,
                padding: "2px 7px",
                flexShrink: 0,
              }}
            >
              {score}
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 14, fontSize: 11, color: "var(--t4)" }}>
            <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ width: 9, height: 9, borderRadius: "50%", background: langColor }} />
              {lang}
            </span>
            <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <svg width="11" height="11" viewBox="0 0 16 16" fill="var(--gold)" aria-hidden="true">
                <path d={STAR_PATH} />
              </svg>
              <span className="tnum">{stars}</span>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
