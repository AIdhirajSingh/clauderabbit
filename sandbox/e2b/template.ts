/**
 * The E2B template every scan VM starts from (DESIGN.md section 3.1).
 *
 * E2B Template builder v2, SDK e2b@2.56.0. Every version below is pinned and
 * every downloaded artifact is checked against a published digest before use.
 * Built on key day by `node sandbox/e2b/build.ts` (needs E2B_API_KEY), which
 * prints the template id. The same template serves the detonation sandbox and
 * the analysis sandbox; the network policy differs per sandbox at create time.
 *
 * The build ends with a full smoke detonation of a local test package through
 * cr-detonate.sh (forge redirect, envd refusal, fake clock, dependency
 * postinstall under npm 11), and fails on any failed assertion.
 */

import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Template } from "e2b";

export const TEMPLATE_NAME_DEFAULT = "clauderabbit-detonate";

export const PINS = {
  ubuntu: "24.04",
  node: { version: "24.22.0", sha256: "cc2f601cee82d9a5a233302fe307abc600727035fd7d2c3a3571755989e95008" },
  uv: { version: "0.13.1", sha256: "eadd9d27c134ab5ac1ffd4473b97a741407f3ea238288f03121fc4deddf90220" },
  python: { mitmproxy: "12.2.3", semgrep: "1.181.0", guarddog: "3.2.0", yaraX: "1.21.0" },
} as const;

export const APT_PACKAGES = [
  "ca-certificates",
  "curl",
  "nftables",
  "strace",
  "libfaketime",
  "python3",
  "python3-venv",
  "openssl",
  "git",
  "build-essential",
  "util-linux",
  "procps",
  "iproute2",
  "jq",
  "xz-utils",
];

const here = dirname(fileURLToPath(import.meta.url));

const NODE_TARBALL = `node-v${PINS.node.version}-linux-x64.tar.xz`;
const UV_TARBALL = "uv-x86_64-unknown-linux-gnu.tar.gz";

/** Rule files are copied one by one so the destination layout is exact. */
export function ruleFiles(kind: "semgrep" | "yara", ext: string): string[] {
  const files = readdirSync(join(here, "rules", kind))
    .filter((f) => f.endsWith(ext))
    .sort()
    .map((f) => `rules/${kind}/${f}`);
  if (files.length === 0) throw new Error(`no ${kind} rules found`);
  return files;
}

export function buildTemplate() {
  return (
    Template({ fileContextPath: here })
      .fromUbuntuImage(PINS.ubuntu)
      .setUser("root")
      .aptInstall(APT_PACKAGES, { noInstallRecommends: true })
      .runCmd([
        "mkdir -p /opt/cr/bin /opt/cr/forge /opt/cr/rules/semgrep /opt/cr/rules/yara /opt/cr/tools/bin /opt/cr/node /opt/cr/mirror",
        // Node 24 LTS, digest pinned and cross-checked against the release SHASUMS256.txt.
        `cd /tmp && curl -fsSLO https://nodejs.org/dist/v${PINS.node.version}/${NODE_TARBALL}`,
        `cd /tmp && curl -fsSLO https://nodejs.org/dist/v${PINS.node.version}/SHASUMS256.txt`,
        `cd /tmp && echo "${PINS.node.sha256}  ${NODE_TARBALL}" | sha256sum -c -`,
        `cd /tmp && grep " ${NODE_TARBALL}$" SHASUMS256.txt | sha256sum -c -`,
        `tar -xJf /tmp/${NODE_TARBALL} -C /opt/cr/node --strip-components=1 && rm -f /tmp/${NODE_TARBALL} /tmp/SHASUMS256.txt`,
        // uv, digest pinned.
        `cd /tmp && curl -fsSLO https://github.com/astral-sh/uv/releases/download/${PINS.uv.version}/${UV_TARBALL}`,
        `cd /tmp && echo "${PINS.uv.sha256}  ${UV_TARBALL}" | sha256sum -c -`,
        `tar -xzf /tmp/${UV_TARBALL} -C /opt/cr/tools/bin --strip-components=1 && rm -f /tmp/${UV_TARBALL}`,
        "/opt/cr/tools/bin/uv --version | grep -q '^uv " + PINS.uv.version + "'",
      ])
      .setEnvs({ UV_TOOL_DIR: "/opt/cr/tools/uv", UV_TOOL_BIN_DIR: "/opt/cr/tools/bin", UV_PYTHON_DOWNLOADS: "never" })
      .runCmd([
        `/opt/cr/tools/bin/uv tool install --python /usr/bin/python3 mitmproxy==${PINS.python.mitmproxy}`,
        `/opt/cr/tools/bin/uv tool install --python /usr/bin/python3 semgrep==${PINS.python.semgrep}`,
        `/opt/cr/tools/bin/uv tool install --python /usr/bin/python3 guarddog==${PINS.python.guarddog}`,
        "/opt/cr/tools/bin/uv venv /opt/cr/venv --python /usr/bin/python3",
        `/opt/cr/tools/bin/uv pip install --python /opt/cr/venv/bin/python yara-x==${PINS.python.yaraX}`,
        "/opt/cr/tools/bin/mitmdump --version | grep -q 'Mitmproxy: " + PINS.python.mitmproxy + "'",
        "/opt/cr/tools/bin/semgrep --version | grep -qx '" + PINS.python.semgrep + "'",
      ])
      // The repo user. No sudo, no login shell, uid 1001 (matched by `meta skuid 1001`).
      .runCmd([
        "groupadd --gid 1001 cr",
        "useradd --uid 1001 --gid 1001 --create-home --home-dir /home/cr --shell /usr/sbin/nologin cr",
        "passwd -l cr",
        "test \"$(id -u cr)\" = 1001",
        "! command -v sudo >/dev/null || ! sudo -l -U cr 2>/dev/null | grep -q '(ALL'",
      ])
      .copy("guest/cr-detonate.sh", "/opt/cr/bin/cr-detonate.sh", { mode: 0o755 })
      .copy("guest/cr-analyze.sh", "/opt/cr/bin/cr-analyze.sh", { mode: 0o755 })
      .copy("guest/cr-yara.py", "/opt/cr/bin/cr-yara.py", { mode: 0o755 })
      .copy("guest/cr-smoke.sh", "/opt/cr/bin/cr-smoke.sh", { mode: 0o755 })
      .copy("guest/cr-mirror-warm.py", "/opt/cr/bin/cr-mirror-warm.py", { mode: 0o755 })
      .copy("guest/forge_core.py", "/opt/cr/forge/forge_core.py", { mode: 0o644 })
      .copy("guest/forge_addon.py", "/opt/cr/forge/forge_addon.py", { mode: 0o644 })
      .copy("guest/policy.json", "/opt/cr/forge/policy.json", { mode: 0o644 })
      .copy("mirror-seed.json", "/opt/cr/mirror-seed.json", { mode: 0o644 })
      .copy(ruleFiles("semgrep", ".yaml"), "/opt/cr/rules/semgrep/", { mode: 0o644 })
      .copy(ruleFiles("yara", ".yar"), "/opt/cr/rules/yara/", { mode: 0o644 })
      .runCmd([
        "chown -R root:root /opt/cr && chmod -R go-w /opt/cr && chmod 0700 /opt/cr/mirror",
        // Record the installed versions for the report's template provenance.
        "dpkg-query -W -f='${Package}=${Version}\\n' " + APT_PACKAGES.join(" ") + " | jq -R -s 'split(\"\\n\") | map(select(length>0))' > /tmp/apt.json",
        "jq -n --slurpfile apt /tmp/apt.json --arg node \"$(/opt/cr/node/bin/node --version)\" --arg npm \"$(/opt/cr/node/bin/npm --version)\" " +
          "--arg uv \"$(/opt/cr/tools/bin/uv --version)\" --arg mitm \"$(/opt/cr/tools/bin/mitmdump --version | head -n1)\" " +
          "--arg semgrep \"$(/opt/cr/tools/bin/semgrep --version)\" --arg guarddog \"$(/opt/cr/tools/bin/guarddog --version 2>&1 | tail -n1)\" " +
          "'{apt:$apt[0], node:$node, npm:$npm, uv:$uv, mitmproxy:$mitm, semgrep:$semgrep, guarddog:$guarddog}' > /opt/cr/manifest.json",
        "rm -f /tmp/apt.json",
      ])
      // Warm the mirror through the forge's own verification path.
      .runCmd("/usr/bin/python3 /opt/cr/bin/cr-mirror-warm.py /opt/cr/mirror-seed.json")
      // Full smoke detonation; the template build fails unless every assertion holds.
      .runCmd("/opt/cr/bin/cr-smoke.sh")
  );
}
