#!/usr/bin/env bash
# build-detonation-base.sh — build the base detonation image ONCE on the host (buildkit).
# Context = the Dockerfile + the in-guest harness + the forge's root CA. The per-scan
# image is then a thin `FROM cr-detonation-base + COPY <repo> /repo` (buildkit-cached).
set -euo pipefail
HERE="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
NERDCTL="${CR_NERDCTL:-/usr/local/bin/nerdctl}"
CA="${CR_FORGE_CA:-/root/.mitmproxy/mitmproxy-ca-cert.pem}"
CTX=/tmp/cr-det-base-ctx
rm -rf "$CTX"; mkdir -p "$CTX"
cp "$HERE/detonation-base.Dockerfile" "$CTX/Dockerfile"
cp "$HERE/guest/detonate.py" "$CTX/detonate.py"
cp "$CA" "$CTX/mitmproxy-ca-cert.pem"
"$NERDCTL" build -t cr-detonation-base:latest "$CTX" >/tmp/cr-base-build.log 2>&1
echo "CR_BASE_IMAGE_BUILT $("$NERDCTL" images cr-detonation-base --format '{{.Repository}}:{{.Tag}}' 2>/dev/null | head -1)"
