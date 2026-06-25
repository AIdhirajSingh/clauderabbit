#!/usr/bin/env bash
#
# setup-network.sh — Provision the hermetic VPC + firewall for the Claude Rabbit
# dynamic sandbox.
#
# SAFETY-CRITICAL. This is the network half of the hermetic isolation rail
# (CLAUDE.md: "its network egress is locked down"). It builds a dedicated VPC
# with NO route to the public internet for the sandbox VM during the RUN phase,
# so that a malicious repo's outbound attempt is BLOCKED — and that block is the
# detection signal.
#
# Model:
#   - A dedicated VPC `cr-sandbox-vpc` (custom subnet mode) isolated from default.
#   - One subnet `cr-sandbox-subnet` in the chosen region.
#   - DENY-ALL egress firewall at priority 1000 (overrides GCP's implicit
#     allow-all-egress at priority 65535).
#   - A NARROW allow-egress rule (priority 900) for GitHub + package CDNs, used
#     ONLY during a controlled clone/provision phase, then DELETED before the run
#     phase via `lock-egress`. In the proof we instead pre-stage the repo onto the
#     VM so the run phase needs zero egress at all.
#   - The VM is booted with `--no-address` (no external IP) during the locked run,
#     so even DNS/metadata-only paths cannot reach arbitrary hosts.
#
# Idempotent: safe to re-run. Usage:
#   setup-network.sh create  <region>
#   setup-network.sh lock-egress            # delete the temporary allow rule
#   setup-network.sh open-egress <region>   # recreate the temporary allow rule
#   setup-network.sh teardown               # delete the whole VPC + rules
set -euo pipefail

VPC="cr-sandbox-vpc"
SUBNET="cr-sandbox-subnet"
TAG="cr-sandbox"                 # network tag applied to sandbox VMs
DENY_EGRESS_RULE="cr-sandbox-deny-egress"
ALLOW_CLONE_RULE="cr-sandbox-allow-clone-egress"
ALLOW_SSH_RULE="cr-sandbox-allow-iap-ssh"
SUBNET_CIDR="10.200.0.0/24"

log() { echo "[net] $*" >&2; }

ensure_vpc() {
  if ! gcloud compute networks describe "$VPC" >/dev/null 2>&1; then
    log "creating VPC $VPC (custom subnet mode)"
    gcloud compute networks create "$VPC" \
      --subnet-mode=custom \
      --bgp-routing-mode=regional >/dev/null
  else
    log "VPC $VPC already exists"
  fi
}

ensure_subnet() {
  local region="$1"
  if ! gcloud compute networks subnets describe "$SUBNET" --region="$region" >/dev/null 2>&1; then
    log "creating subnet $SUBNET ($SUBNET_CIDR) in $region"
    # Private Google Access OFF: the sandbox must not reach Google APIs either.
    gcloud compute networks subnets create "$SUBNET" \
      --network="$VPC" \
      --region="$region" \
      --range="$SUBNET_CIDR" \
      --no-enable-private-ip-google-access >/dev/null
  else
    log "subnet $SUBNET already exists in $region"
  fi
}

# DENY-ALL egress at priority 1000. GCP has an implicit allow-all-egress at the
# lowest priority (65535); a lower number wins, so this rule blocks ALL outbound
# from tagged sandbox VMs to every destination. This is the lockdown.
ensure_deny_egress() {
  if ! gcloud compute firewall-rules describe "$DENY_EGRESS_RULE" >/dev/null 2>&1; then
    log "creating DENY-ALL egress rule $DENY_EGRESS_RULE (priority 1000)"
    gcloud compute firewall-rules create "$DENY_EGRESS_RULE" \
      --network="$VPC" \
      --direction=EGRESS \
      --action=DENY \
      --rules=all \
      --destination-ranges=0.0.0.0/0 \
      --priority=1000 \
      --target-tags="$TAG" \
      --enable-logging >/dev/null
  else
    log "deny-egress rule already exists"
  fi
}

# Allow IAP-based SSH INGRESS so the orchestrator can scp the harness + collect
# results without giving the VM an external IP. IAP's TCP-forwarding range is
# 35.235.240.0/20. This is INGRESS only — it does not grant the repo any egress.
ensure_iap_ssh() {
  if ! gcloud compute firewall-rules describe "$ALLOW_SSH_RULE" >/dev/null 2>&1; then
    log "creating IAP SSH ingress rule $ALLOW_SSH_RULE"
    gcloud compute firewall-rules create "$ALLOW_SSH_RULE" \
      --network="$VPC" \
      --direction=INGRESS \
      --action=ALLOW \
      --rules=tcp:22 \
      --source-ranges=35.235.240.0/20 \
      --priority=1000 \
      --target-tags="$TAG" >/dev/null
  else
    log "IAP SSH rule already exists"
  fi
}

# Temporary narrow egress allow for a controlled clone/provision phase only.
# Higher priority (900) than the deny (1000) so it wins while present. The
# orchestrator deletes it (lock_egress) before running untrusted code. In the
# proof we skip this entirely and pre-stage the repo, so the run phase has the
# deny rule active and NO allow rule — fully locked.
open_egress() {
  if ! gcloud compute firewall-rules describe "$ALLOW_CLONE_RULE" >/dev/null 2>&1; then
    log "creating temporary clone-egress allow rule $ALLOW_CLONE_RULE (priority 900)"
    # tcp:443 (https git/clone, package registries), tcp:53/udp:53 (DNS) only.
    gcloud compute firewall-rules create "$ALLOW_CLONE_RULE" \
      --network="$VPC" \
      --direction=EGRESS \
      --action=ALLOW \
      --rules=tcp:443,tcp:53,udp:53 \
      --destination-ranges=0.0.0.0/0 \
      --priority=900 \
      --target-tags="$TAG" \
      --enable-logging >/dev/null
  else
    log "clone-egress allow rule already exists"
  fi
}

lock_egress() {
  if gcloud compute firewall-rules describe "$ALLOW_CLONE_RULE" >/dev/null 2>&1; then
    log "deleting clone-egress allow rule — EGRESS NOW FULLY LOCKED"
    gcloud compute firewall-rules delete "$ALLOW_CLONE_RULE" --quiet >/dev/null
  else
    log "no clone-egress allow rule present — egress already locked"
  fi
}

teardown() {
  for r in "$ALLOW_CLONE_RULE" "$DENY_EGRESS_RULE" "$ALLOW_SSH_RULE"; do
    if gcloud compute firewall-rules describe "$r" >/dev/null 2>&1; then
      log "deleting firewall rule $r"
      gcloud compute firewall-rules delete "$r" --quiet >/dev/null
    fi
  done
  # subnet must go before the network
  for region in $(gcloud compute networks subnets list --network="$VPC" --format="value(region)" 2>/dev/null | sort -u); do
    log "deleting subnet $SUBNET in $region"
    gcloud compute networks subnets delete "$SUBNET" --region="$region" --quiet >/dev/null 2>&1 || true
  done
  if gcloud compute networks describe "$VPC" >/dev/null 2>&1; then
    log "deleting VPC $VPC"
    gcloud compute networks delete "$VPC" --quiet >/dev/null
  fi
  log "teardown complete"
}

main() {
  local cmd="${1:-}"
  case "$cmd" in
    create)
      local region="${2:?usage: setup-network.sh create <region>}"
      ensure_vpc
      ensure_subnet "$region"
      ensure_deny_egress
      ensure_iap_ssh
      log "network ready: VPC=$VPC subnet=$SUBNET tag=$TAG (egress DENIED by default)"
      ;;
    open-egress)
      open_egress
      ;;
    lock-egress)
      lock_egress
      ;;
    teardown)
      teardown
      ;;
    *)
      echo "usage: $0 {create <region>|open-egress|lock-egress|teardown}" >&2
      exit 2
      ;;
  esac
}

main "$@"
