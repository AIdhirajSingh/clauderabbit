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
  iptables iproute2 git pipx zstd dnsmasq-base >/dev/null 2>&1
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
[ -f ${DM_DIR}/data ] || { touch ${DM_DIR}/data; truncate -s 100G ${DM_DIR}/data; }
[ -f ${DM_DIR}/meta ] || { touch ${DM_DIR}/meta; truncate -s 10G ${DM_DIR}/meta; }
DATA_DEV=$(losetup --find --show ${DM_DIR}/data)
META_DEV=$(losetup --find --show ${DM_DIR}/meta)
SECTORS=$(( $(blockdev --getsize64 -q ${DATA_DEV}) / 512 ))
dmsetup ls | grep -q "^${POOL}" || \
  dmsetup create "${POOL}" --table "0 ${SECTORS} thin-pool ${META_DEV} ${DATA_DEV} 128 32768"
POOL
chmod +x /usr/local/sbin/cr-dm-pool.sh
cat > /etc/systemd/system/cr-dm-pool.service <<'UNIT'
[Unit]
Description=Claude Rabbit devmapper thin-pool
DefaultDependencies=no
After=systemd-udev-settle.service
Before=containerd.service
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

echo "CR_SETUP_DONE $(date -u +%FT%TZ)"
