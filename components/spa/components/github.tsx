"use client";

/**
 * Real GitHub surfaces — owner avatars and repo links.
 *
 * Both GitHub endpoints used here are PUBLIC and need no token:
 *   - `https://github.com/<owner>.png` redirects to the owner's real avatar.
 *   - `https://github.com/<owner>/<repo>` is the public repo page.
 *
 * `OwnerAvatar` renders the real avatar image and gracefully falls back to the
 * design's gradient-initial circle if the image fails to load (deleted owner,
 * offline, blocked) — so a missing avatar never leaves a broken-image icon and
 * the report still reads. It is a client component (the `onError` fallback needs
 * the browser); embedded inside the server-rendered report page this still SSRs
 * the `<img>` and only the fallback swap runs after hydration.
 *
 * `RepoLink` wraps a repo's `owner/name` text in an external link to its GitHub
 * page, opened in a new tab with `rel="noopener noreferrer"` so the opened page
 * can never reach back into this app via `window.opener`.
 */

import { useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import styles from "../spa.module.css";

interface OwnerAvatarProps {
  /** The GitHub owner login (used for both the avatar URL and the fallback). */
  owner: string;
  /** The letter shown in the fallback circle (usually the display-name initial). */
  initial: string;
  /** Square pixel size of the avatar. */
  size: number;
  /** Fallback circle background (matches the design's per-surface gradient). */
  gradient: string;
  /** Fallback initial font size. */
  fontSize: number;
}

/**
 * The owner's real GitHub avatar, falling back to the gradient-initial circle.
 * The fallback's visual is byte-identical to the design's original avatar block,
 * so a failed image is indistinguishable from the prior look.
 */
export function OwnerAvatar({ owner, initial, size, gradient, fontSize }: OwnerAvatarProps) {
  const [failed, setFailed] = useState(false);

  const base: CSSProperties = {
    width: size,
    height: size,
    borderRadius: "50%",
    flexShrink: 0,
  };

  if (failed || !owner) {
    return (
      <div
        style={{
          ...base,
          background: gradient,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize,
          fontWeight: 600,
          color: "#fff",
        }}
        aria-hidden="true"
      >
        {initial}
      </div>
    );
  }

  return (
    // A plain <img> is intentional: this is a tiny external GitHub avatar, and
    // routing it through next/image would force a `github.com` remotePatterns
    // entry plus on-demand optimization for no real LCP/bandwidth win at this
    // size. The graceful onError fallback below also needs a raw <img>.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      // `?size` asks GitHub for an appropriately-sized avatar (retina-doubled).
      src={`https://github.com/${encodeURIComponent(owner)}.png?size=${size * 2}`}
      alt={`${owner} avatar`}
      width={size}
      height={size}
      loading="lazy"
      onError={() => setFailed(true)}
      style={{ ...base, objectFit: "cover", background: "var(--s3)" }}
    />
  );
}

interface RepoLinkProps {
  owner: string;
  name: string;
  children: ReactNode;
  style?: CSSProperties;
}

/** An external link to a repo's public GitHub page (new tab, opener-isolated). */
export function RepoLink({ owner, name, children, style }: RepoLinkProps) {
  return (
    <a
      href={`https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`}
      target="_blank"
      rel="noopener noreferrer"
      className={styles.repoExtLink}
      style={{ color: "inherit", textDecoration: "none", ...style }}
    >
      {children}
    </a>
  );
}
