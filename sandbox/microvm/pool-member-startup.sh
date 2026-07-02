#!/usr/bin/env bash
# pool-member-startup.sh — GCE startup-script attached to every MANAGED-POOL member via the
# instance template (create-pool.sh). It runs on every boot of a pool member.
#
# WHY: the golden image bakes cr-idle-shutdown.timer, which poweroffs an idle host after ~30m.
# That is correct reclaim for the STANDALONE single host (cr-host-build), but WRONG for a MIG
# member: the MIG reconciler keeps targetSize members RUNNING, so a member that self-stops is
# immediately restarted — the watchdog and the group fight (VERIFIED live). In a MIG the group
# owns the lifecycle: reclaim happens by resizing targetSize down (app-driven scale-in in
# /api/deep) so surplus members return to the disk-only stopped standby pool. So a pool member
# must NOT self-poweroff. We mask the watchdog here rather than baking a second golden image,
# keeping ONE image whose MIG-vs-standalone difference is expressed purely in the template.
#
# Idempotent + safe: masking an already-masked unit is a no-op. Everything else the member
# needs (cr-dm-pool.service + cr-base-image.service rebuilding the fresh pool + base image,
# containerd, buildkit, Kata/FC) is untouched and still runs on boot exactly as baked.
set -uo pipefail
{
  echo "cr-pool-member-startup: masking cr-idle-shutdown on this MIG member (MIG owns lifecycle)"
  systemctl stop    cr-idle-shutdown.timer   2>/dev/null || true
  systemctl disable cr-idle-shutdown.timer   2>/dev/null || true
  systemctl mask    cr-idle-shutdown.timer   2>/dev/null || true
  systemctl mask    cr-idle-shutdown.service 2>/dev/null || true
  echo "cr-pool-member-startup: idle watchdog masked; timer=$(systemctl is-active cr-idle-shutdown.timer 2>/dev/null || echo inactive)"
} 2>&1 | logger -t cr-pool-member-startup
