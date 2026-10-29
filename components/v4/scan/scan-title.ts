/**
 * The scan page's heading. A stored run played back (a cache hit, or ?replay=1)
 * says so: it never reads as a live "Scanning".
 */
export function scanTitle(s: { done: boolean; failed: boolean; stored: boolean }): string {
  if (s.stored) return s.done ? "Stored scan" : "Playing a stored scan";
  return s.done ? "Scan complete" : s.failed ? "Scan stopped" : "Scanning";
}

/** True when the page is showing a run that already finished: every streamed event is a replay. */
export function isStored(replayParam: boolean, events: ReadonlyArray<{ replayed?: boolean }>): boolean {
  return replayParam || (events.length > 0 && events.every((e) => e.replayed === true));
}
