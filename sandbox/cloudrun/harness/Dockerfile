# Dockerfile — the Cloud Run Job execution image: the real "run untrusted code
# safely" workload for Claude Rabbit's dynamic sandbox, NEW architecture.
#
# OLD vs NEW (read before editing): the old detonation-base.Dockerfile
# (sandbox/microvm/detonation-base.Dockerfile) built a base image that a
# per-scan microVM booted from, with the forge's CA baked in at BUILD time and
# egress isolation coming from a per-run network-namespace forge on a
# persistent host. Cloud Run Gen2 containers get NO CAP_NET_ADMIN — there is no
# netns/iptables to run inside this container — so isolation is now the Cloud
# Run container boundary itself (replaces the microVM), and egress containment
# comes from an already-deployed gateway VM (10.200.0.10) that a GCP custom
# route forces ALL outbound traffic through. This image therefore:
#   - carries the SAME language-runtime stack (this is what decides the
#     real-world auto-build success rate — keep it, it's load-bearing);
#   - does NOT bake a CA at build time (the CA lives on the shared gateway, not
#     per-image) — entrypoint.sh fetches it from the gateway at container START;
#   - is a single, already-running container (no per-scan `FROM base + COPY
#     repo` image build — the repo is cloned into /repo inside this already-
#     running container by entrypoint.sh).
#
# NODE 22 + COREPACK — this is the "real developer environment" that decides the
# auto-build success rate (the number that makes "we run it" real). Repos pin
# their package manager (`packageManager: pnpm@10`, `yarn@4`) and those versions
# need Node 22+, so a pinned-pnpm install crashed on Node 20 and a plain `npm
# install` died on the `workspace:` protocol. Node 22 ships corepack, which
# fetches + runs each repo's OWN pinned package manager (proven: vite builds
# with pnpm 10, TanStack/query with pnpm 11) — every fetch still goes through
# the gateway's registry fast-path, so no new egress path opens and containment
# is unchanged.
FROM node:22-slim

# python3 for the harness (detonate.py, assemble-forensics.py, the agent
# package — stdlib + google-genai only) and the build/observe toolchain.
# unzip is needed by the OpenCode/deno installers below. gnupg/ca-certificates
# support the installer curl|sh scripts and TLS generally.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip python3-venv strace ca-certificates git curl unzip \
    && rm -rf /var/lib/apt/lists/*

# Enable corepack so `yarn`/`pnpm` resolve to the repo's pinned version (downloaded on
# first use through the gateway's registry fast-path, exactly like npm — no new egress
# path). Keep a global yarn@1 + pnpm@9 as the fallback for repos that pin NO
# packageManager field, so the native tool always exists even without a pin.
# COREPACK_ENABLE_DOWNLOAD_PROMPT=0 is CRITICAL: the container runs unattended/
# non-interactively, and without it corepack blocks on a "download? [Y/n]" prompt
# and the whole build hangs until the run cap kills it.
#
# `--force` is REQUIRED here (caught in a real Cloud Build run, not a guess):
# node:22-slim ships a preinstalled /usr/local/bin/yarn, so a plain
# `npm install -g yarn` fails with EEXIST — and since this whole RUN line ended
# in `|| true` (to make cache-clean's own transient failure non-fatal), that
# EEXIST failure was being silently swallowed, meaning pnpm@9 never actually
# installed. `--force` lets npm's yarn overwrite the preinstalled shim (fine —
# corepack governs which yarn actually resolves at runtime anyway) so the
# install genuinely succeeds instead of degrading unnoticed.
RUN corepack enable && npm install -g --force --no-audit --no-fund yarn pnpm@9 \
    && npm cache clean --force 2>/dev/null || true

# The agent package's only third-party Python dependency: google-genai, used
# lazily by agent/vertex_client.py as the OpenCode-unavailable fallback path.
# Installed at build time (not per-scan) so the fallback never depends on a
# registry fetch racing the scan's own time budget.
RUN pip3 install --no-cache-dir --break-system-packages google-genai

# deno + OpenCode — the agentic exploration pass's actual brain. Same installers
# provision-host.sh already uses for the (retired) per-host provisioning path;
# replicated here at IMAGE build time since Cloud Run has no persistent host to
# provision once. Installed to a fixed, non-home path (/opt/cr/tools) so the
# binaries exist regardless of which uid the container runs as, and so
# entrypoint.sh can reference them by a stable path rather than $HOME (Cloud
# Run's runtime uid/HOME are not guaranteed to match the build-time user).
ENV DENO_INSTALL=/opt/cr/tools/deno \
    OPENCODE_INSTALL_DIR=/opt/cr/tools/opencode/bin
RUN mkdir -p /opt/cr/tools \
    && curl -fsSL https://deno.land/install.sh | sh -s -- -y \
    && curl -fsSL https://opencode.ai/install | bash \
    && chmod -R a+rX /opt/cr/tools

# PATH: repo-pinned Node/corepack tools first (already on the base image PATH),
# then our fixed-path deno + OpenCode installs.
ENV PATH="/opt/cr/tools/deno/bin:/opt/cr/tools/opencode/bin:${PATH}" \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# The harness (entrypoint + detonate.py + assemble-forensics.py, unchanged) and
# the full agent package (parallel_agents.py + its imports: agent_loop.py,
# detonator.py, knowledge_graph.py, opencode_client.py, vertex_client.py,
# scan_files.ts, security_methodology.md).
COPY entrypoint.sh /opt/cr/entrypoint.sh
COPY detonate.py /opt/cr/detonate.py
COPY assemble-forensics.py /opt/cr/assemble-forensics.py
COPY agent/ /opt/cr/agent/
RUN chmod +x /opt/cr/entrypoint.sh

WORKDIR /opt/cr
ENTRYPOINT ["/opt/cr/entrypoint.sh"]
