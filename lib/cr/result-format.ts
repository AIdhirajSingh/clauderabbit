/**
 * Plain presentation of the result page's sections. Every value comes from the
 * stored report; this only shortens, deduplicates and rewords it. Nothing is added.
 */

/** Shortens a long line in the middle so both the start and the file name stay readable. */
export function shortMiddle(s: string, max = 64): string {
  const t = s.trim();
  if (t.length <= max) return t;
  const keep = max - 1;
  const head = Math.ceil(keep * 0.45);
  return `${t.slice(0, head)}…${t.slice(t.length - (keep - head))}`;
}

const RULE_WORDS: Array<[RegExp, string]> = [
  [/^secret/, "Key-shaped string"],
  [/^shell_fetch/, "Downloads and runs a script"],
  [/^obfusc|^encoded|^base64/, "Hidden or encoded code"],
  [/^exec|^child_process|^spawn/, "Runs a system command"],
  [/^env/, "Reads environment variables"],
  [/^net|^http|^fetch/, "Makes a network call"],
];

/** One evidence line in plain words: what was found and where, without rule ids or weights. */
export function plainEvidence(e: string): string {
  const h = e.match(/^-?\d+:\s*heuristic\s+heur\.([a-z_]+)[\w.]*\s+at\s+(.+?)(?:\s+\((?:install|import)\))?$/i);
  if (h?.[1] && h[2]) {
    const word = RULE_WORDS.find(([re]) => re.test(h[1]!))?.[1] ?? "Flagged code";
    return `${word}: ${h[2]}`;
  }
  const j = e.match(/^-?\d+:\s*Jev [\w ]*check:\s*(malicious|suspicious)\s+at\s+(.+?)\s*\(/i);
  if (j?.[1] && j[2]) return `Judged ${j[1].toLowerCase()}: ${j[2]}`;
  return e.replace(/^-?\d+:\s*/, "");
}

/** A deduction's title in plain words. */
export function plainTitle(detail: string): string {
  const m = detail.match(/^(\d+) reachable finding location/i);
  if (m?.[1]) return `Code flagged in ${m[1]} ${m[1] === "1" ? "place" : "places"} that install or the entry point can reach`;
  return detail;
}

/** At most `cap` evidence lines, in plain words and shortened, plus how many more there are. */
export function evidenceLines(evidence: readonly string[] | undefined, cap = 3): { lines: string[]; more: number } {
  const all = (evidence ?? []).filter(Boolean);
  return { lines: all.slice(0, cap).map((e) => shortMiddle(plainEvidence(e))), more: Math.max(0, all.length - cap) };
}

/** Tool and pipeline names a builder should not need to know. */
const INTERNAL = /\b(semgrep|yara(-x)?|guarddog|osv(\.dev)?|mitmproxy|mitmdump|jev|luna|faketime|harness|forensic(s)?)\b/i;

/** Not verified, as short plain bullets: at most three up front, the rest behind "More". */
export function notVerifiedBullets(items: readonly string[], cap = 3): { shown: string[]; more: string[] } {
  const seen = new Set<string>();
  const clean: string[] = [];
  for (const raw of items) {
    if (INTERNAL.test(raw)) continue;
    const t = raw.replace(/\s+/g, " ").trim().replace(/\.$/, "");
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    clean.push(t);
  }
  return { shown: clean.slice(0, cap), more: clean.slice(cap) };
}

export function humanCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1).replace(/\.0$/, "")}K`;
  return String(n);
}

export function humanAge(days: number): string {
  if (days >= 365) {
    const y = Math.floor(days / 365);
    return `${y} ${y === 1 ? "year" : "years"} old`;
  }
  if (days >= 60) return `${Math.floor(days / 30)} months old`;
  return `${days} ${days === 1 ? "day" : "days"} old`;
}

function sourceLabel(source: string): string {
  if (/npm/i.test(source)) return "npm";
  if (/github/i.test(source)) return "GitHub";
  return source.length > 18 ? shortMiddle(source, 18) : source;
}

/**
 * Reputation facts as short chips with human numbers, one per meaning: the engine
 * can state the same number twice (an "Owner account age" fact and a sentence that
 * repeats it), so chips are keyed by what they say.
 */
export function reputationChips(facts: readonly { fact: string; source: string }[]): { text: string; source: string }[] {
  const out: { text: string; source: string }[] = [];
  const keys = new Set<string>();
  const add = (key: string, text: string, source: string) => {
    if (keys.has(key)) return;
    keys.add(key);
    out.push({ text, source: sourceLabel(source) });
  };
  for (const { fact, source } of facts) {
    const f = fact.replace(/,/g, "");
    let matched = false;
    const age = f.match(/account age:?\s*(\d+)\s*day/i);
    if (age?.[1]) {
      add("owner-age", `Owner ${humanAge(Number(age[1]))}`, source);
      matched = true;
    }
    const repos = f.match(/(\d+)\s+public repositor/i);
    if (repos?.[1]) {
      add("owner-repos", `${humanCount(Number(repos[1]))} public repos`, source);
      matched = true;
    }
    const stars = f.match(/stars:?\s*(\d+)/i) ?? f.match(/(\d+)\s+stars/i);
    if (stars?.[1]) {
      add("stars", `${humanCount(Number(stars[1]))} stars`, source);
      matched = true;
    }
    const weekly = f.match(/weekly downloads:?\s*(\d+)/i);
    if (weekly?.[1]) {
      add("weekly", `${humanCount(Number(weekly[1]))} weekly downloads`, source);
      matched = true;
    }
    const published = f.match(/first publish(?:ed)?:?\s*(\d+)\s*days?/i);
    if (published?.[1]) {
      add("first-publish", `First published ${humanAge(Number(published[1])).replace(" old", " ago")}`, source);
      matched = true;
    }
    if (/^owner not established/i.test(fact)) {
      add("established", "Owner not established", source);
      matched = true;
    }
    if (!matched) add(`raw:${fact.toLowerCase()}`, fact, source);
  }
  return out;
}
