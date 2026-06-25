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
# Model (monitored-SINKHOLE upgrade):
#   - A dedicated VPC `cr-sandbox-vpc` (custom subnet mode) isolated from default.
#   - One subnet `cr-sandbox-subnet` in the chosen region.
#   - DENY-ALL egress firewall at priority 1000 (overrides GCP's implicit
#     allow-all-egress at priority 65535). This is CONTAINMENT LAYER 1 and the
#     fail-closed backstop: anything not explicitly allowed below cannot leave.
#   - A SUBNET-SCOPED allow-egress rule (priority 800) to 10.200.0.0/24 ONLY,
#     targeting the sandbox tag. This lets the detonation VM reach the intra-VPC
#     TRAP host (private IP) on arbitrary ports for the sinkhole, while every
#     internet destination stays DENIED by the priority-1000 rule. Because GCP
#     evaluates the on-the-wire destination AFTER the detonation VM's local
#     iptables DNAT has rewritten it to a 10.200.0.0/24 trap address, even a
#     hardcoded-public-IP connect ends up matching this allow and going to the
#     trap — never the real host. The deny-1000 rule still blocks anything the
#     DNAT misses (ICMP, raw sockets, etc.) — fail-closed.
#   - INGRESS allow on the trap's private interface so the detonation VM can
#     reach the sinkhole; the trap's catch-all ports are NEVER exposed to the
#     public internet (intra-VPC source range only).
#   - The detonation VM is booted with `--no-address` (no external IP) AND
#     `--no-service-account --no-scopes`, so even the link-local metadata path
#     (which VPC egress firewall does NOT govern) carries no stealable creds.
#
# The TRAP host is NOT tagged `cr-sandbox` — it keeps normal egress so it can
# (a) proxy build-phase dependency fetches to package registries ONLY, and
# (b) resolve intended exfil IPs for INTELLIGENCE (never routing detonation
# traffic onward — see net/trap-host.sh: ip_forward=0, FORWARD DROP, no NAT).
#
# Idempotent: safe to re-run. Usage:
#   setup-network.sh create  <region>       # VPC + subnet + deny-1000 + IAP SSH
#   setup-network.sh sinkhole-rules         # add the pri-800 subnet allow + trap ingress
#   setup-network.sh teardown               # delete the whole VPC + rules
set -euo pipefail

VPC="cr-sandbox-vpc"
SUBNET="cr-sandbox-subnet"
TAG="cr-sandbox"                 # network tag applied to detonation VMs
TRAP_TAG="cr-trap"               # network tag applied to the trap/control host
DENY_EGRESS_RULE="cr-sandbox-deny-egress"
# GCP forbids mixing IPv4 and IPv6 ranges in ONE firewall rule, so the IPv6 deny
# is a SEPARATE rule (same priority 1000, same DENY action, dst=::/0). Together
# the two rules deny ALL egress regardless of address family — fail-closed.
DENY_EGRESS_RULE_V6="cr-sandbox-deny-egress-v6"
ALLOW_SSH_RULE="cr-sandbox-allow-iap-ssh"
# Sinkhole rules (the upgrade):
ALLOW_SUBNET_EGRESS_RULE="cr-sandbox-allow-subnet-egress"   # pri 800, dst=subnet only
ALLOW_TRAP_INGRESS_RULE="cr-sandbox-allow-trap-ingress"     # intra-VPC -> trap, all ports
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
  # IPv4 deny (the original lockdown): blocks ALL outbound to 0.0.0.0/0 from
  # tagged sandbox VMs. Priority 1000 beats GCP's implicit allow-all (65535).
  if ! gcloud compute firewall-rules describe "$DENY_EGRESS_RULE" >/dev/null 2>&1; then
    log "creating DENY-ALL IPv4 egress rule $DENY_EGRESS_RULE (priority 1000)"
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
    log "IPv4 deny-egress rule already exists"
  fi

  # IPv6 deny (separate rule — GCP forbids mixed v4/v6 ranges in one rule).
  # The subnet is IPv4-only today, but this closes any future IPv6 egress path
  # explicitly so the deny is family-complete and fail-closed.
  if ! gcloud compute firewall-rules describe "$DENY_EGRESS_RULE_V6" >/dev/null 2>&1; then
    log "creating DENY-ALL IPv6 egress rule $DENY_EGRESS_RULE_V6 (priority 1000, dst=::/0)"
    gcloud compute firewall-rules create "$DENY_EGRESS_RULE_V6" \
      --network="$VPC" \
      --direction=EGRESS \
      --action=DENY \
      --rules=all \
      --destination-ranges="::/0" \
      --priority=1000 \
      --target-tags="$TAG" \
      --enable-logging >/dev/null
  else
    log "IPv6 deny-egress rule already exists"
  fi
}

# Allow IAP-based SSH INGRESS so the orchestrator can scp the harness + collect
# results without giving the VM an external IP. IAP's TCP-forwarding range is
# 35.235.240.0/20. This is INGRESS only — it does not grant the repo any egress.
ensure_iap_ssh() {
  if ! gcloud compute firewall-rules describe "$ALLOW_SSH_RULE" >/dev/null 2>&1; then
    log "creating IAP SSH ingress rule $ALLOW_SSH_RULE (sandbox + trap tags)"
    gcloud compute firewall-rules create "$ALLOW_SSH_RULE" \
      --network="$VPC" \
      --direction=INGRESS \
      --action=ALLOW \
      --rules=tcp:22 \
      --source-ranges=35.235.240.0/20 \
      --priority=1000 \
      --target-tags="$TAG,$TRAP_TAG" >/dev/null
  else
    # Ensure the trap tag is covered even if the rule predates the upgrade.
    local tags
    tags=$(gcloud compute firewall-rules describe "$ALLOW_SSH_RULE" \
      --format="value(targetTags.list())" 2>/dev/null || echo "")
    if ! printf '%s' "$tags" | grep -q "$TRAP_TAG"; then
      log "extending IAP SSH rule target tags to include $TRAP_TAG"
      gcloud compute firewall-rules update "$ALLOW_SSH_RULE" \
        --target-tags="$TAG,$TRAP_TAG" >/dev/null 2>&1 || \
        log "WARNING: could not extend IAP SSH tags; trap SSH may use a separate path"
    else
      log "IAP SSH rule already covers trap tag"
    fi
  fi
}

# SINKHOLE egress allow (the upgrade). Priority 800 (BELOW the deny-1000, so it
# wins) but scoped to the SUBNET CIDR ONLY (10.200.0.0/24) — never 0.0.0.0/0.
# This is the one egress the detonation VM gets: a path to the intra-VPC trap.
# The internet remains denied. This rule is SAFE to leave in place across runs
# precisely because it cannot reach anything outside the private subnet.
#
# NOTE: we deliberately do NOT recreate the old clone-egress 0.0.0.0/0 allow.
# Build-phase dependency fetch now goes through the trap's allowlist proxy, NOT
# a wide-open firewall hole. There is no code path here that opens egress to the
# public internet for a tagged detonation VM — by design.
ensure_subnet_egress() {
  if ! gcloud compute firewall-rules describe "$ALLOW_SUBNET_EGRESS_RULE" >/dev/null 2>&1; then
    log "creating SINKHOLE subnet-egress allow $ALLOW_SUBNET_EGRESS_RULE (priority 800, dst=$SUBNET_CIDR ONLY)"
    gcloud compute firewall-rules create "$ALLOW_SUBNET_EGRESS_RULE" \
      --network="$VPC" \
      --direction=EGRESS \
      --action=ALLOW \
      --rules=all \
      --destination-ranges="$SUBNET_CIDR" \
      --priority=800 \
      --target-tags="$TAG" \
      --enable-logging >/dev/null
  else
    log "subnet-egress allow rule already exists"
  fi
}

# Allow intra-VPC INGRESS to the trap host on ALL ports so the catch-all sink can
# accept any connection the detonation VM makes. Source is the SUBNET only — the
# trap's catch-all ports are NEVER reachable from the public internet, even though
# the trap has an external IP (which it uses only for outbound registry proxying
# and intended-IP resolution).
ensure_trap_ingress() {
  if ! gcloud compute firewall-rules describe "$ALLOW_TRAP_INGRESS_RULE" >/dev/null 2>&1; then
    log "creating trap ingress allow $ALLOW_TRAP_INGRESS_RULE (intra-VPC $SUBNET_CIDR -> trap, all ports)"
    gcloud compute firewall-rules create "$ALLOW_TRAP_INGRESS_RULE" \
      --network="$VPC" \
      --direction=INGRESS \
      --action=ALLOW \
      --rules=all \
      --source-ranges="$SUBNET_CIDR" \
      --priority=900 \
      --target-tags="$TRAP_TAG" >/dev/null
  else
    log "trap ingress allow rule already exists"
  fi
}

teardown() {
  for r in "$ALLOW_SUBNET_EGRESS_RULE" "$ALLOW_TRAP_INGRESS_RULE" "$DENY_EGRESS_RULE" "$DENY_EGRESS_RULE_V6" "$ALLOW_SSH_RULE"; do
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
      ensure_subnet_egress
      ensure_trap_ingress
      log "network ready: VPC=$VPC subnet=$SUBNET tag=$TAG (egress DENIED to internet; subnet $SUBNET_CIDR allowed for sinkhole)"
      ;;
    sinkhole-rules)
      ensure_subnet_egress
      ensure_trap_ingress
      ;;
    teardown)
      teardown
      ;;
    *)
      echo "usage: $0 {create <region>|sinkhole-rules|teardown}" >&2
      exit 2
      ;;
  esac
}

main "$@"
