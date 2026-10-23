"use client";

import { useLayoutEffect, useRef } from "react";

/**
 * Keeps the report's two columns ending together at desktop widths: while the right rail ends more than its last
 * card's height below the left column, that card moves to the end of the left column. At 760 px and below the page
 * is one column in source order and nothing moves. The cards are static server markup.
 */
export function ColumnBalance({ cols }: { cols: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const grid = cols ? ref.current?.parentElement?.querySelector<HTMLElement>(`.${CSS.escape(cols)}`) : null;
    if (!cols || !grid || window.matchMedia("(max-width: 760px)").matches) return;
    const [left, right] = Array.from(grid.children) as HTMLElement[];
    if (!left || !right) return;
    const bottom = (el: HTMLElement) => el.lastElementChild?.getBoundingClientRect().bottom ?? el.getBoundingClientRect().top;
    for (let i = 0; i < 4 && right.children.length > 1; i++) {
      const last = right.lastElementChild as HTMLElement;
      const h = last.getBoundingClientRect().height;
      if (bottom(right) - bottom(left) <= h) break;
      left.appendChild(last);
    }
  }, [cols]);
  return <span ref={ref} hidden />;
}
