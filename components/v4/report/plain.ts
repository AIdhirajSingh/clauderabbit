/**
 * Turns engine evidence and check text into plain words for the public report. Pure: no I/O, no React.
 * Rule ids, point prefixes and probabilities never reach the page; the file and line, when there is one,
 * come back separately so the report can show it in a code chip. Points are shown in "Points taken off".
 */

export interface PlainEvidence {
  /** What was found, in plain words. */
  text: string;
  /** file:line (or file) the evidence points at, when it names one. */
  where: string | null;
}

/** Plain phrase per heuristic id from lib/engine/static/heuristics.ts. */
const HEURISTIC: Record<string, string> = {
  "heur.cred.aws_credentials": "Code reads the AWS credentials file",
  "heur.cred.bulk_env": "Code copies the whole environment, secrets included",
  "heur.cred.cloud_config": "Code reads cloud or Git credential files",
  "heur.cred.npmrc": "Code reads the npm login token file",
  "heur.cred.shell_history": "Code reads the shell history",
  "heur.cred.ssh_key": "Code reads SSH private keys",
  "heur.dynamic_function": "Code builds and runs new code at runtime",
  "heur.install_hook": "The package runs a script when it is installed",
  "heur.network.internal_ip": "Code contacts a private network address",
  "heur.network.public_ip": "Code contacts a hard-coded internet address",
  "heur.obfuscation.atob_eval": "Code decodes hidden text and runs it",
  "heur.obfuscation.eval_decoded": "Code decodes hidden text and runs it",
  "heur.obfuscation.exec_base64_literal": "Code runs a long encoded string",
  "heur.obfuscation.function_decoded": "Code decodes hidden text and runs it",
  "heur.obfuscation.hex_escapes": "Code hides a long string in hex escapes",
  "heur.obfuscation.py_exec_decoded": "Python code decodes hidden text and runs it",
  "heur.package_json.invalid": "package.json could not be read",
  "heur.secret.aws_key_id": "An AWS access key is written into the code",
  "heur.secret.github_token": "A GitHub token is written into the code",
  "heur.secret.private_key": "A private key is written into the code",
  "heur.secret.sk_key": "A secret API key is written into the code",
  "heur.secret.slack_token": "A Slack token is written into the code",
  "heur.setup_py.custom_install": "setup.py replaces the normal install step",
  "heur.setup_py.dynamic_exec": "setup.py runs code it builds at install time",
  "heur.setup_py.os_system": "setup.py runs a system command",
  "heur.setup_py.subprocess": "setup.py starts another program",
  "heur.shell_fetch.distribution": "A shell script downloads and runs code from a known distribution site",
  "heur.shell_fetch.internal": "A shell script downloads and runs code from a private address",
  "heur.shell_fetch.unrecognized": "A shell script downloads and runs code from an unrecognised source",
  "heur.typosquat": "The name is close to a popular package's name",
};

const GENERIC = "A code pattern the scanners flag";

/** A heuristic id in plain words; an unknown id gets the generic phrase, never the id. */
export function heuristicPhrase(id: string): string {
  return HEURISTIC[id] ?? GENERIC;
}

const VERDICT_WORD: Record<string, string> = {
  malicious: "malicious",
  suspicious: "suspicious",
  benign: "harmless",
  unclear: "unclear",
};

/** Strips a "-5:" point prefix and a trailing "(install)" / "(import, p=0.92)" note. */
function strip(s: string): string {
  return s
    .replace(/^\s*[-+−]?\d+(?:\.\d+)?\s*:\s*/, "")
    .replace(/\s*\((?:install|import|entry|build|run)?(?:\s*,?\s*p=\d+(?:\.\d+)?)?\)\s*$/i, "")
    .trim();
}

/** Any rule id left inside free text becomes plain words. */
function scrubIds(s: string): string {
  return s
    .replace(/\bheuristic\s+(heur\.[\w.]+)/gi, (_m, id: string) => heuristicPhrase(id))
    .replace(/\bheur\.[\w.]+/gi, (id) => heuristicPhrase(id))
    .replace(/\s*\bp=\d+(?:\.\d+)?/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** One evidence string from the engine, as plain words plus where it points. */
export function plainEvidence(raw: string): PlainEvidence {
  const s = strip(raw);
  const h = s.match(/^heuristic\s+(heur\.[\w.]+)(?:\s+at\s+(.+))?$/i);
  if (h?.[1]) return { text: heuristicPhrase(h[1]), where: h[2]?.trim() || null };
  const j = s.match(/^Jev\s+(\w+)\s+check:\s*(\w+)(?:\s+at\s+(.+))?$/i);
  if (j?.[2]) {
    const word = VERDICT_WORD[j[2].toLowerCase()];
    return { text: word ? `Jev judged this code ${word}` : "Jev checked this code", where: j[3]?.trim() || null };
  }
  const at = s.match(/^(.+?)\s+at\s+([\w./@\-[\]]+(?::\d+)?)$/);
  if (at?.[1] && at[2] && /(?:\/|\.[A-Za-z]\w*)(?::\d+)?$/.test(at[2])) return { text: scrubIds(at[1]) || GENERIC, where: at[2] };
  return { text: scrubIds(s) || GENERIC, where: null };
}

/** A deduction title or other free line, with rule ids and weights removed. */
export function plainLine(raw: string): string {
  return plainEvidence(raw).text;
}

const JEV_QUESTION: Record<string, [yes: string, no: string]> = {
  install_network: ["Install-time code uses the network", "Install-time code does not use the network"],
  install_credentials: ["Install-time code reads credentials", "Install-time code does not read credentials"],
  install_exec: ["Install-time code runs other programs or payloads", "Install-time code does not run other programs or payloads"],
  install_obfuscation: ["Install-time code is obfuscated", "Install-time code is not obfuscated"],
  declares_no_network: ["The docs say it makes no network calls", "The docs do not say it makes no network calls"],
  declares_pure: ["The docs say it has no side effects", "The docs do not say it has no side effects"],
};

/**
 * A Jev transcript ("Jev install check: install surface install_network=true p=0.56; ...") as plain sentences.
 * Unknown parts are left out rather than shown raw.
 */
export function plainJev(raw: string): PlainEvidence[] {
  const body = raw.replace(/^\s*Jev\s+\w+\s+check:\s*/i, "");
  const out: PlainEvidence[] = [];
  const seen = new Set<string>();
  const add = (text: string, where: string | null = null) => {
    const k = `${text}|${where ?? ""}`;
    if (!seen.has(k)) { seen.add(k); out.push({ text, where }); }
  };
  for (const part of body.split(";")) {
    const t = part.trim();
    if (!t) continue;
    const q = t.match(/\b(install_\w+|declares_\w+)=(true|false)\b/);
    if (q?.[1] && q[2]) {
      const pair = JEV_QUESTION[q[1]];
      if (pair) add(q[2] === "true" ? pair[0] : pair[1]);
      continue;
    }
    if (/\bconsistent\b/i.test(t)) { add("What it did fits what its docs say it is for"); continue; }
    if (/\bmismatch\b/i.test(t)) { add("What it did goes beyond what its docs say it is for"); continue; }
    const v = t.match(/^(.*?)\s+(malicious|suspicious|benign|unclear)\b/i);
    if (v?.[1] && v[2]) {
      const file = v[1].trim();
      const word = VERDICT_WORD[v[2].toLowerCase()]!;
      const isFile = Boolean(file) && /[./]/.test(file) && !/\s/.test(file);
      add(`Jev judged this code ${word}`, isFile ? file : null);
    }
  }
  return out;
}
