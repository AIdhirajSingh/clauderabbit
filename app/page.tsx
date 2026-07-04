"use client";

/**
 * The ClaudeRabbit single-page app entry. The full interactive prototype
 * (`design-source/Claude Rabbit.dc.html`) is ported under `components/spa`;
 * this route simply mounts it. The theme attribute is applied to <html> before
 * paint by the no-flash script in `app/layout.tsx`.
 */

import { AppRoot } from "@/components/spa/AppRoot";

export default function HomePage() {
  return <AppRoot />;
}
