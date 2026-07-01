#!/usr/bin/env bash
# teardown-host.sh — explicitly reclaim the detonation host (belt to the idle watchdog).
# Run at session end so the host never lingers running unattended.
#
#   stop   (default) — power the host OFF: reclaims the expensive running compute, keeps the
#                      boot disk so provision-host.sh can `start` it again quickly.
#   delete           — remove the instance entirely (substrate is fully reproducible via
#                      provision-host.sh, so this loses nothing that isn't in committed code).
set -uo pipefail
PROJECT="${CR_GCP_PROJECT:-gen-lang-client-0062239756}"
ZONE="${CR_SANDBOX_ZONE:-us-central1-a}"
HOST="${CR_SANDBOX_HOST:-cr-host-build}"
ACTION="${1:-stop}"
case "$ACTION" in
  stop)   gcloud --project "$PROJECT" compute instances stop   "$HOST" --zone "$ZONE" --quiet && echo "CR_HOST_STOPPED $HOST" ;;
  delete) gcloud --project "$PROJECT" compute instances delete "$HOST" --zone "$ZONE" --quiet && echo "CR_HOST_DELETED $HOST" ;;
  *) echo "usage: teardown-host.sh [stop|delete]" >&2; exit 2 ;;
esac
