"use client";

/**
 * Ad screen — faithful port of `design-source/Claude Rabbit.dc.html`
 * lines ~412–452: the 15s countdown ring over a striped "Ad slot" placeholder,
 * the global loader noting the background work, and the (demo) skip button.
 */

import { useApp } from "../state";
import styles from "../spa.module.css";
import { Loader } from "../components/Loader";

const AD_RING_LEN = 138.2;

export function AdScreen() {
  const app = useApp();
  const adCount = app.state.adCount;
  const adRingOffset = AD_RING_LEN * (1 - adCount / 15);

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: 32,
        animation: "screenIn .5s var(--ease) both",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 11, marginBottom: 28 }}>
        <span style={{ fontSize: 10.5, color: "var(--t4)", letterSpacing: "0.18em", textTransform: "uppercase" }}>
          Sponsored
        </span>
        <span style={{ width: 3, height: 3, borderRadius: "50%", background: "var(--t5)" }} />
        <span style={{ fontSize: 13, color: "var(--t3)" }}>Your scan is running while this plays</span>
      </div>

      <div
        style={{
          position: "relative",
          width: "min(600px,92vw)",
          aspectRatio: "16/9",
          borderRadius: 22,
          overflow: "hidden",
          border: "1px solid var(--line2)",
          background: "linear-gradient(135deg, #0b0b0c, #101012)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          boxShadow: "0 30px 80px rgba(0,0,0,0.6)",
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            opacity: 0.5,
            background:
              "repeating-linear-gradient(135deg, transparent, transparent 13px, rgba(255,255,255,0.045) 13px, rgba(255,255,255,0.045) 26px)",
          }}
        />
        <div style={{ textAlign: "center", position: "relative" }}>
          <div className="serif" style={{ fontSize: 26, color: "rgba(255,255,255,0.82)", letterSpacing: "0.02em" }}>
            Ad slot
          </div>
          <div style={{ fontSize: 12.5, color: "rgba(255,255,255,0.52)", marginTop: 6, letterSpacing: "0.04em" }}>
            Rewarded video placeholder
          </div>
        </div>
        <div style={{ position: "absolute", top: 18, right: 18, width: 52, height: 52 }}>
          <svg width="52" height="52" viewBox="0 0 52 52" style={{ transform: "rotate(-90deg)" }} aria-hidden="true">
            <circle cx="26" cy="26" r="22" fill="rgba(0,0,0,0.5)" stroke="rgba(255,255,255,0.22)" strokeWidth="3" />
            <circle
              cx="26"
              cy="26"
              r="22"
              fill="none"
              stroke="#fff"
              strokeWidth="3"
              strokeLinecap="round"
              strokeDasharray="138.2"
              strokeDashoffset={adRingOffset}
              style={{ transition: "stroke-dashoffset 1s linear" }}
            />
          </svg>
          <div
            className="tnum"
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 17,
              fontWeight: 600,
              color: "#fff",
            }}
          >
            {adCount}
          </div>
        </div>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 15,
          marginTop: 32,
          padding: "14px 20px",
          border: "1px solid var(--line)",
          borderRadius: 14,
          background: "var(--s1)",
        }}
      >
        <Loader size={5} gap={4} radius={1.5} />
        <span style={{ fontSize: 13, color: "var(--t3)" }}>Cloning and analyzing in the background</span>
      </div>

      <button
        onClick={app.skipAd}
        className={styles.skipBtn}
        style={{
          marginTop: 22,
          background: "transparent",
          border: "none",
          color: "var(--t5)",
          fontSize: 12.5,
          cursor: "pointer",
          transition: "color .16s var(--ease)",
        }}
      >
        Skip ad (demo)
      </button>
    </div>
  );
}
