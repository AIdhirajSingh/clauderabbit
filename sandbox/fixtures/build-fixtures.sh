#!/usr/bin/env bash
#
# build-fixtures.sh — tar up the SYNTHETIC fixture source dirs into the *.tar.gz
# tarballs the orchestrator stages onto the detonation VM.
#
# All fixtures here are SYNTHETIC, authored locally, and NEVER published. They
# emulate attack SHAPES (install-time exfil, run-time C2 exfil, mining, and a
# benign dependency-fetching repo) so the sinkhole engine can be proven on live
# GCP without any real malware.
#
# The produced *.tar.gz are gitignored (sandbox/**/*.tar.gz).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
log() { echo "[fixtures] $*" >&2; }

build_one() {
  local dir="$1"
  [ -d "$HERE/$dir" ] || { log "skip: $dir (no source dir)"; return; }
  log "packing $dir -> $dir.tar.gz"
  tar -czf "$HERE/$dir.tar.gz" -C "$HERE/$dir" .
}

build_one cred-stealer
build_one miner
build_one exfil-c2
build_one benign-deps

log "fixtures built:"
ls -la "$HERE"/*.tar.gz 2>/dev/null || true
