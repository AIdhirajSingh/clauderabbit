#!/usr/bin/env bash
# setup-host.sh — install the Claude Rabbit microVM detonation substrate on a single
# Ubuntu 24.04 host (the NEW architecture: one warm host + Kata/Firecracker microVMs,
# replacing the two-full-VM design). Runs as root on the host. Idempotent where it can be.
#
# Stack (per docs/runs/2026-06-28-sandbox-architecture-rebuild.md research synthesis):
#   - containerd + the devmapper snapshotter (MANDATORY for the Firecracker path — FC has
#     no virtio-fs, so the container rootfs must be a block device from a dm thin-pool).
#   - Kata Containers 3.x static + Firecracker + jailer (pinned to Kata's manifest version).
#   - kata-fc runtime/shim bound to the Firecracker hypervisor config.
#   - mitmproxy (the deceptive forging egress engine) + its root CA (baked into guests later).
#
# Self-verifying: every stage prints CR_STAGE_<name> ok/FAIL and a CR_FACT_* line for the
# discovered specifics (versions, config paths) so the orchestrator config is built from
# real facts, never guessed. Read via: bash setup-host.sh 2>&1 | tee /var/log/cr-host-setup.log
set -uo pipefail
KATA_VER="${KATA_VER:-3.32.0}"
ARCH="$(uname -m)"   # x86_64
# Kata + many release assets name the x86_64 arch "amd64", not "x86_64".
case "$ARCH" in x86_64) KARCH=amd64 ;; aarch64) KARCH=arm64 ;; *) KARCH="$ARCH" ;; esac
mark() { echo "CR_STAGE_$1 $2"; }
fact() { echo "CR_FACT_$1 $2"; }
echo "CR_SETUP_START $(date -u +%FT%TZ) kata=${KATA_VER} arch=${ARCH}"

# ── Stage 0: KVM gate ────────────────────────────────────────────────────────────────
if [ -e /dev/kvm ]; then mark KVM ok; else mark KVM FAIL; echo "no /dev/kvm — abort"; exit 1; fi

# ── Stage 1: base packages ───────────────────────────────────────────────────────────
export DEBIAN_FRONTEND=noninteractive
apt-get update -y >/dev/null 2>&1
apt-get install -y ca-certificates curl gnupg jq bc dmsetup squashfs-tools e2fsprogs \
  iptables iproute2 git pipx zstd dnsmasq-base thin-provisioning-tools >/dev/null 2>&1
mark BASEPKGS $?

# ── Stage 2: containerd (Docker repo build — known-good devmapper snapshotter) ───────
install -m0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc 2>/dev/null
chmod a+r /etc/apt/keyrings/docker.asc
. /etc/os-release
echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update -y >/dev/null 2>&1
apt-get install -y containerd.io >/dev/null 2>&1
mark CONTAINERD $?
fact CONTAINERD_VER "$(containerd --version 2>/dev/null | awk '{print $3}')"

# ── Stage 3: devmapper thin-pool (loopback-backed; recreate-on-boot via systemd) ─────
DM_DIR=/var/lib/containerd/devmapper
POOL=cr-devpool
mkdir -p ${DM_DIR}
cat > /usr/local/sbin/cr-dm-pool.sh <<'POOL'
#!/usr/bin/env bash
set -e
DM_DIR=/var/lib/containerd/devmapper; POOL=cr-devpool
mkdir -p ${DM_DIR}
# Healthy + active pool (e.g. a live re-run of setup-host.sh on a running host) → leave it
# untouched so we never wipe a pool in use.
if dmsetup ls 2>/dev/null | grep -q "^${POOL}" && dmsetup status ${POOL} 2>/dev/null | grep -q " rw "; then
  exit 0
fi
# Otherwise — a fresh boot (dm devices don't survive a reboot) or a broken/read-only pool —
# build a CLEAN pool from FRESH backing files. THIS IS THE CRITICAL SELF-CLEANING-HOST FIX:
# a poweroff (which the idle-shutdown watchdog does routinely to reclaim the host) leaves the
# loopback thin-pool metadata inconsistent — the metadata loop then throws WRITE I/O errors,
# the pool goes read-only, and every detonation "builds nothing". Recovery via
# thin_check/thin_repair does NOT reliably clear it. The pool only ever holds the REPRODUCIBLE
# base image + cached clones, so resetting it fresh each boot is the robust, deterministic
# recovery (PROVEN: fresh pool -> rebuild base -> detonation builds rc=0, contained). The base
# image is rebuilt onto the fresh pool by cr-base-image.service.
dmsetup remove ${POOL} 2>/dev/null || true
for f in data meta; do
  dev=$(losetup -j ${DM_DIR}/${f} -O NAME -n 2>/dev/null | awk 'NR==1{print $1}')
  [ -n "${dev}" ] && losetup -d "${dev}" 2>/dev/null || true
done
rm -f ${DM_DIR}/data ${DM_DIR}/meta
truncate -s 100G ${DM_DIR}/data
truncate -s 10G ${DM_DIR}/meta
DATA_DEV=$(losetup --find --show ${DM_DIR}/data)
META_DEV=$(losetup --find --show ${DM_DIR}/meta)
SECTORS=$(( $(blockdev --getsize64 -q ${DATA_DEV}) / 512 ))
dmsetup create "${POOL}" --table "0 ${SECTORS} thin-pool ${META_DEV} ${DATA_DEV} 128 32768"
touch /run/cr-pool-fresh   # signal cr-base-image.service to (re)build the base image
POOL
chmod +x /usr/local/sbin/cr-dm-pool.sh
cat > /etc/systemd/system/cr-dm-pool.service <<'UNIT'
[Unit]
Description=Claude Rabbit devmapper thin-pool
# Must run AFTER the root fs is remounted read-write (the fresh-pool reset rm's + truncates
# the backing files — that fails with "Read-only file system" if it runs in very early boot,
# e.g. under DefaultDependencies=no) but BEFORE containerd opens the pool.
After=local-fs.target systemd-udev-settle.service
Before=containerd.service
RequiresMountsFor=/var/lib/containerd
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/cr-dm-pool.sh
RemainAfterExit=yes
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable cr-dm-pool.service >/dev/null 2>&1
/usr/local/sbin/cr-dm-pool.sh
mark DMPOOL $?
fact DMPOOL_STATE "$(dmsetup ls 2>/dev/null | grep "${POOL}" | tr '\t' ' ' || echo MISSING)"

# ── Stage 3b: base-image rebuild service (pairs with the fresh-pool reset) ────────────
# cr-dm-pool resets the pool fresh on every boot (see above), so the base detonation image
# (a pool snapshot) is gone after a restart. This boot service rebuilds it onto the fresh
# pool from the committed /opt/cr/microvm code, so a host that the watchdog stopped and that
# is later restarted (by provision-host.sh OR a bare `instances start`) always has a valid
# base image before the first detonation. Idempotent: skips the rebuild if the pool wasn't
# reset and the image is already present.
cat > /usr/local/sbin/cr-base-image.sh <<'BI'
#!/usr/bin/env bash
set -uo pipefail
NERDCTL=/usr/local/bin/nerdctl
BUILD=/opt/cr/microvm/build-detonation-base.sh
CA=/root/.mitmproxy/mitmproxy-ca-cert.pem
[ -x "$BUILD" ] || { echo "cr-base-image: $BUILD missing (deploy code first)"; exit 0; }
need=0
[ -f /run/cr-pool-fresh ] && need=1
"$NERDCTL" images cr-detonation-base --format '{{.Repository}}' 2>/dev/null | grep -q cr-detonation-base || need=1
if [ "$need" = 1 ]; then
  echo "cr-base-image: (re)building base image onto the fresh pool"
  "$NERDCTL" rmi -f cr-detonation-base:latest >/dev/null 2>&1 || true
  CR_FORGE_CA="$CA" bash "$BUILD" && rm -f /run/cr-pool-fresh
else
  echo "cr-base-image: base image present, pool not reset — nothing to do"
fi
BI
chmod +x /usr/local/sbin/cr-base-image.sh
cat > /etc/systemd/system/cr-base-image.service <<'UNIT'
[Unit]
Description=Claude Rabbit detonation base-image (re)build after a fresh pool
After=buildkit.service containerd.service network-online.target
Wants=buildkit.service network-online.target
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/cr-base-image.sh
RemainAfterExit=yes
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable cr-base-image.service >/dev/null 2>&1
mark BASEIMGSVC $?

# ── Stage 4: Kata Containers static ──────────────────────────────────────────────────
# Kata static is zstd-compressed (.tar.zst), named with amd64 (not x86_64).
curl -fsSL "https://github.com/kata-containers/kata-containers/releases/download/${KATA_VER}/kata-static-${KATA_VER}-${KARCH}.tar.zst" -o /tmp/kata.tar.zst
fact KATA_DL_BYTES "$(stat -c%s /tmp/kata.tar.zst 2>/dev/null || echo 0)"
tar --use-compress-program=unzstd -xf /tmp/kata.tar.zst -C / 2>/dev/null
mark KATA $?
for b in /opt/kata/bin/*; do ln -sf "$b" /usr/local/bin/ 2>/dev/null; done
fact KATA_VER_INSTALLED "$(/opt/kata/bin/kata-runtime --version 2>/dev/null | head -1 | tr '\n' ' ')"
fact KATA_CONFIGS "$(ls /opt/kata/share/defaults/kata-containers/ 2>/dev/null | tr '\n' ' ')"
FC_CFG=/opt/kata/share/defaults/kata-containers/configuration-fc.toml
fact KATA_FC_CFG_PRESENT "$([ -f "$FC_CFG" ] && echo yes || echo NO)"
[ -f "$FC_CFG" ] && fact KATA_FC_PATHS "$(grep -E '^(path|kernel|image|initrd|jailer_path)\s*=' "$FC_CFG" | tr '\n' '|')"

# ── Stage 5: Firecracker + jailer (bundled by Kata, else release binary) ─────────────
if [ -x /opt/kata/bin/firecracker ]; then
  fact FC_SOURCE "kata-bundled"
  fact FC_VER "$(/opt/kata/bin/firecracker --version 2>/dev/null | head -1)"
else
  REL="https://github.com/firecracker-microvm/firecracker/releases"
  FCV="$(basename "$(curl -fsSLI -o /dev/null -w '%{url_effective}' ${REL}/latest)")"
  curl -fsSL ${REL}/download/${FCV}/firecracker-${FCV}-${ARCH}.tgz | tar -xz -C /tmp
  install -m0755 /tmp/release-${FCV}-${ARCH}/firecracker-${FCV}-${ARCH} /usr/local/bin/firecracker
  install -m0755 /tmp/release-${FCV}-${ARCH}/jailer-${FCV}-${ARCH} /usr/local/bin/jailer
  fact FC_SOURCE "release-${FCV}"
  fact FC_VER "$(/usr/local/bin/firecracker --version 2>/dev/null | head -1)"
fi
mark FIRECRACKER ok

# ── Stage 5b: wire containerd (devmapper snapshotter) + the kata-fc runtime shim ─────
# containerd 2.x config (version=3). The devmapper snapshotter is MANDATORY for the FC
# path (FC has no virtio-fs -> container rootfs is a dm-thin block device).
mkdir -p /etc/containerd
cat > /etc/containerd/config.toml <<'CDCFG'
version = 3
[plugins."io.containerd.snapshotter.v1.devmapper"]
  pool_name = "cr-devpool"
  root_path = "/var/lib/containerd/devmapper"
  base_image_size = "10GB"
  discard_blocks = true
CDCFG
# kata-fc shim wrapper: bind the generic Kata shim to the Firecracker hypervisor config.
cat > /usr/local/bin/containerd-shim-kata-fc-v2 <<'SHIM'
#!/usr/bin/env bash
KATA_CONF_FILE=/opt/kata/share/defaults/kata-containers/configuration-fc.toml exec /opt/kata/bin/containerd-shim-kata-v2 "$@"
SHIM
chmod +x /usr/local/bin/containerd-shim-kata-fc-v2
# Kata-FC networking: tcfilter (the default) — Kata turns the run netns's veth eth0 into
# the microVM's tap itself; the forge attaches via a cross-netns veth (see forge/forge-up.sh).
sed -i 's/^internetworking_model = .*/internetworking_model = "tcfilter"/' "$FC_CFG" 2>/dev/null || true
systemctl restart containerd; sleep 2
fact DEVMAPPER_PLUGIN "$(ctr plugins ls 2>/dev/null | awk '/devmapper/{print $1, $4}')"
mark KATAFC ok

# ── Stage 6: mitmproxy (the deceptive forging egress engine) + root CA ───────────────
pipx install mitmproxy >/dev/null 2>&1 || pip3 install --break-system-packages mitmproxy >/dev/null 2>&1
MITM="$(command -v mitmdump || echo /root/.local/bin/mitmdump)"
fact MITM_BIN "$MITM"
fact MITM_VER "$($MITM --version 2>/dev/null | head -1 | tr '\n' ' ')"
# generate the CA non-interactively (mitmproxy writes ~/.mitmproxy/mitmproxy-ca-cert.pem on first run)
timeout 8 $MITM --no-server >/dev/null 2>&1 || true
fact MITM_CA "$([ -f /root/.mitmproxy/mitmproxy-ca-cert.pem ] && echo present || echo MISSING)"
mark MITM ok

# ── Stage 7: nerdctl-full (buildkit + buildctl) — build the per-scan detonation image ─
# The orchestrator builds a thin per-scan image (base detonation image + the repo clone)
# via buildkit, then detonates it via kata-fc. nerdctl-full bundles buildkitd + buildctl.
NCV="$(basename "$(curl -fsSLI -o /dev/null -w '%{url_effective}' https://github.com/containerd/nerdctl/releases/latest)")"
NCV="${NCV#v}"
curl -fsSL "https://github.com/containerd/nerdctl/releases/download/v${NCV}/nerdctl-full-${NCV}-linux-${KARCH}.tar.gz" -o /tmp/nerdctl-full.tgz
tar -xzf /tmp/nerdctl-full.tgz -C /usr/local 2>/dev/null
fact NERDCTL_VER "$(/usr/local/bin/nerdctl --version 2>/dev/null | awk '{print $3}')"
# Use the CONTAINERD worker (not OCI) so buildkit shares containerd's image store: a
# locally-built base image resolves as `FROM`, and built images land where `ctr run` finds them.
mkdir -p /etc/buildkit
printf '[worker.oci]\n  enabled = false\n[worker.containerd]\n  enabled = true\n  namespace = "default"\n' > /etc/buildkit/buildkitd.toml
# start buildkitd (the nerdctl-full tarball ships the systemd unit)
systemctl enable --now buildkit >/dev/null 2>&1 || true
sleep 1
fact BUILDKITD "$(systemctl is-active buildkit 2>/dev/null || (command -v buildkitd >/dev/null && echo present) || echo MISSING)"
mark BUILDKIT ok

# ── Stage 8: idle auto-shutdown watchdog (COST SAFETY RAIL, RE-SCOPED) ────────────────
# RE-SCOPE (2026-07): the ALWAYS-ON production microVM substrate host must NEVER be
# idle-stopped by this watchdog — stopping it cold-starts the next real scan (pool +
# base-image rebuild), which is the exact "silently-failing escalation" failure the
# host was found in. Its running cost is bounded by the instance-level 12h
# max-run-duration=STOP backstop (set in provision-host.sh) plus the operator, NOT by
# this timer. The watchdog now protects only DISPOSABLE dev/build/probe instances: it
# idle-stops a host ONLY when it can positively confirm the host is NOT the production
# substrate. Identity comes from the GCE metadata server (labels are not exposed there,
# but the instance name + custom metadata are):
#   • exempt when custom metadata `cr-idle-exempt=1` is present (the explicit flag
#     provision-host.sh sets on the substrate host), OR
#   • exempt when the instance name matches CR_PROD_HOST_NAME (default cr-host-build).
# Fail-safe: if metadata is unreachable (identity unknown) it does NOT stop — a warm
# host is never sacrificed to a transient metadata blip. A genuinely abandoned host is
# still reclaimed by the 12h max-run backstop even while exempt here.
cat > /usr/local/sbin/cr-idle-shutdown.sh <<'WD'
#!/usr/bin/env bash
set -uo pipefail
IDLE_MIN="${CR_IDLE_MIN:-30}"
PROD_NAME="${CR_PROD_HOST_NAME:-cr-host-build}"
HB=/run/cr-activity
md() { curl -s -m 3 -H 'Metadata-Flavor: Google' \
  "http://metadata.google.internal/computeMetadata/v1/instance/$1" 2>/dev/null; }

# Positive-ID exemption for the always-on production substrate host.
name="$(md name)"
if [ -z "$name" ]; then
  echo "cr-idle: instance identity unknown (metadata unreachable) — not stopping (fail-safe)"
  exit 0
fi
if [ "$(md attributes/cr-idle-exempt)" = "1" ] || [ "$name" = "$PROD_NAME" ]; then
  echo "cr-idle: '$name' is the production substrate host — exempt from idle-stop (cost bounded by the 12h max-run backstop)"
  exit 0
fi

# Disposable instance: reclaim it when genuinely idle (never mid-scan).
now=$(date +%s)
# self-seed once per boot (/run is tmpfs) so idle is measured from boot, not the epoch
[ -f "$HB" ] || { : > "$HB"; echo "cr-idle: seeded heartbeat at boot"; exit 0; }
last=$(stat -c %Y "$HB" 2>/dev/null || echo 0)
if who 2>/dev/null | grep -q . \
   || pgrep -f 'orchestrate-microvm\.sh|ctr run|firecracker|mitmdump|opencode run' >/dev/null 2>&1; then
  last=$now; touch "$HB"           # active login or detonation in flight → reset the clock
fi
idle=$(( (now - last) / 60 ))
echo "cr-idle: [$name] idle=${idle}m threshold=${IDLE_MIN}m"
if [ "$idle" -ge "$IDLE_MIN" ]; then
  echo "cr-idle: idle>=${IDLE_MIN}m on disposable host — powering off to reclaim (cost rail)"
  ${CR_IDLE_DRYRUN:+echo DRYRUN-would:} /sbin/poweroff
fi
WD
chmod +x /usr/local/sbin/cr-idle-shutdown.sh
cat > /etc/systemd/system/cr-idle-shutdown.service <<'UNIT'
[Unit]
Description=Claude Rabbit idle auto-shutdown (cost rail, production-host-exempt)
[Service]
Type=oneshot
Environment=CR_IDLE_MIN=30
Environment=CR_PROD_HOST_NAME=cr-host-build
ExecStart=/usr/local/sbin/cr-idle-shutdown.sh
UNIT
cat > /etc/systemd/system/cr-idle-shutdown.timer <<'UNIT'
[Unit]
Description=Periodic Claude Rabbit idle auto-shutdown check
[Timer]
OnBootSec=10min
OnUnitActiveSec=10min
AccuracySec=1min
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now cr-idle-shutdown.timer >/dev/null 2>&1
mark IDLEWATCHDOG $?
fact IDLE_TIMER "$(systemctl is-active cr-idle-shutdown.timer 2>/dev/null || echo inactive)"

echo "CR_SETUP_DONE $(date -u +%FT%TZ)"
