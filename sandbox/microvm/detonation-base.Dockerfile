# detonation-base.Dockerfile — the base image every detonation microVM boots from.
# Carries the in-guest harness, the language runtimes a real build needs, strace for
# observation, and the forge's root CA in the trust store so a NON-pinning TLS client
# (the malware) completes the handshake to the forge and reveals its payload.
# The per-scan image is just `FROM cr-detonation-base` + `COPY <repo> /repo` (a thin
# layer buildkit caches), so detonation start stays fast.
#
# NODE 22 + COREPACK — this is the "real developer environment" that decides the auto-build
# success rate (the number that makes "we run it" real). The prior base shipped Debian's
# Node 20 + a single global pnpm, which could not build the modern-monorepo mainstream:
# repos pin their package manager (`packageManager: pnpm@10`, `yarn@4`) and those versions
# need Node 22+, so a pinned-pnpm install crashed and a plain `npm install` died on the
# `workspace:` protocol. Node 22 ships corepack, which fetches + runs each repo's OWN pinned
# package manager (proven: vite builds with pnpm 10, TanStack/query with pnpm 11) — every
# fetch still goes through the forge's registry fast-path, so no new egress path opens and
# containment is unchanged.
FROM node:22-slim

# python3 for the in-guest harness (detonate.py, stdlib only); the build/observe toolchain.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 strace ca-certificates git curl \
    && rm -rf /var/lib/apt/lists/*

# Enable corepack so `yarn`/`pnpm` resolve to the repo's pinned version (downloaded on first
# use through the forge registry, exactly like npm — no new egress path). Keep a global
# yarn@1 + pnpm@9 as the fallback for repos that pin NO packageManager field, so the native
# tool always exists even without a pin. COREPACK_ENABLE_DOWNLOAD_PROMPT=0 is CRITICAL: the
# microVM is non-interactive, and without it corepack blocks on a "download? [Y/n]" prompt
# and the whole build hangs until the run cap kills it.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    COREPACK_DEFAULT_TO_LATEST=1
RUN corepack enable && npm install -g --no-audit --no-fund yarn pnpm@9 \
    && npm cache clean --force 2>/dev/null || true

# The forge CA -> trusted, so the guest's TLS clients trust the forge's per-SNI leaf.
COPY mitmproxy-ca-cert.pem /usr/local/share/ca-certificates/cr-forge-ca.crt
RUN update-ca-certificates
ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
    REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt \
    NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# The in-guest harness (configures egress->forge, plants decoys, runs+observes the repo).
COPY detonate.py /opt/cr/detonate.py
WORKDIR /repo
