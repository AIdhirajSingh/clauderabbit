# Run doc — Sandbox architecture rebuild + whole-product optimization (2026-06-28)

This is the live record for the architecture-rebuild mandate. The prompt IS the spec; where it
conflicts with older infra docs, the spec wins (and I update the docs to match). Reorient from here
after any compaction; execute unit by unit, each proven in the localhost browser, merged.

## The mandate (condensed)
- **A. Sandbox:** replace the two-full-GCP-VM design with ONE small warm host VM (golden image, BASE env
  baked only) running the trusted static read directly + fat pipe; run the DETONATION in a Kata/Firecracker
  microVM (Firecracker THROUGH Kata Containers — hardware-grade kernel isolation, ~125ms boot, disposable,
  reset per run). NOT Docker/gVisor/two-full-VMs. The project's OWN deps install at request time inside the
  microVM (unavoidable/correct). Isolation absolute across the boundary (no shared mem/storage; the small
  microVM->analysis copy is the airlock). DECEPTIVE forging egress replaces the sinkhole: intercept every
  outbound conn and ANSWER AS IF THE REAL DESTINATION ANSWERED (forge C2 handshake/success) so
  condition-gated malware unlocks + runs full real behavior on a stage we record; registry traffic on a
  controlled logged fast path; NO real packet leaves; decoy creds only; full reset; zero orphan microVMs;
  dead-man's switch.
- **B. Speed:** REAL ~30s wall-clock stage-1-start -> full report rendered (typical), not a budget/partial.
  Warm pool, reuse stage-1 clone+comprehension, parallelize everything, fat ~100Mbps+ pipe, per-phase
  instrumentation (our-overhead vs repo's genuine build, reported separately), fix the worst phase.
- **C. Agents:** REAL OpenCode + three real parallel streaming agents (lead + workers); knowledge graph +
  cross-verification; every report claim traces to real evidence. No placeholder/batch/single-lead.
- **D. Report:** precision/accuracy/content/presentation from EXISTING design.md; forensics first-class;
  no hedge language ever on escalated; never a bare "Safe"; reputation visually separate.
- **E. Whole-product:** Lighthouse 95+, low latency, SEO (SSR/metadata/structured data/CWV), secure +
  production-grade, scalable + NO queueing (concurrent scans = isolated microVMs), bloat-free, full-codebase
  audit for fabricated data / dead controls / honesty violations / contradictions / bloat.

Discipline: per-unit aidhiraj_protocol; one-unit git; main green; gitleaks never bypassed; prove in the
localhost browser; do not regress inline moat / honest verdict / determinism (fresh==cached per SHA) /
containment / de-faked shell / auth / U1-U5. Only real wall = a step needing the user's personal login.

## Comprehension — current architecture (baseline being replaced)
- `sandbox/orchestrate.sh` (~510 lines): boots TWO e2-small VMs in parallel — a TRAP host (debian-12,
  full egress, runs squid registry-proxy + dnsmasq sinkhole DNS + sinkd.py catch-all sink + tcpdump) and a
  DETONATION VM (golden image, `--no-address --no-service-account --no-scopes --tags=cr-sandbox`,
  deny-1000 egress firewall, `--max-run-duration=30m --instance-termination-action=DELETE` dead-man).
  Phases: BUILD (deps via proxy allowlist) -> AGENTIC (opt-in CR_AGENTIC) -> RUN (sinkhole-flip: DNAT all
  egress to trap) -> RESET (delete detonation VM async). Streams `[orch]` milestones parsed by /api/deep.
- Egress today = SINKHOLE: dnsmasq answers every query with trap IP; sinkhole-flip DNATs all detonation
  egress to the trap; `sinkd.py` terminates ANY TCP/TLS/HTTP, peeks SNI, replies HTTP 200, records inert.
  Sees only the doomed first knock -> condition-gated malware goes dormant -> false-clean. THIS is the gap.
- Agent today = `sandbox/agent/agent_loop.py`: ONE Vertex lead (gemini-3.1-flash-lite) explore/detonate
  loop, OFF-VM on the orchestrator, opt-in (CR_AGENTIC=0 default), batch (not streamed live). Not OpenCode,
  not three agents. C1-C5 audit rails (repo=untrusted data, facts code-verified, budget<cage) are binding.
- Observation: `observe.py` strace syscall trace, 12 canary cred files, network snapshot. `verdict.py`
  deterministic score, asserts no bare "Safe". `forensics.py` emits the canonical record.
- Machine types TODAY: both e2-small (2 vCPU). e2 does NOT support nested virtualization.
- grep: NO firecracker/kata/microvm/nested-virt/kvm anywhere in the repo yet. Pure full-GCE today.

## Infra facts that gate the rebuild (from docs/INFRASTRUCTURE.md)
- GCP project `gen-lang-client-0062239756` (ClaudeRabbit), gcloud authed as manishpratapsingh@gmail.com.
- **FREE-TRIAL account**: $300 credit (expires 24 Sep 2026); restrictions: no GPUs, **max 8 Compute cores
  at once**, no Windows images, **no quota-increase requests**. Linux/no-GPU/default-quota is fine.
- Nested virtualization on GCP needs a Haswell+ machine type (N1/N2/C2/C3 — NOT e2) with nested virt
  enabled. n2-standard-8 (8 vCPU) fits the 8-core cap. WHETHER THIS TRIAL ACCOUNT PERMITS NESTED VIRT IS
  THE LOAD-BEARING UNKNOWN — establish empirically (A0), do not predict.

## Unit plan (dependency order) — each proven in the browser, merged
- **A0 — Feasibility probe (THE foundation experiment):** create an N2 VM with nested virt enabled on the
  REAL account; confirm `/dev/kvm` + `kvm-ok`; install Firecracker; boot a minimal microVM; measure boot.
  If it boots -> the whole microVM substrate is real, proceed. If the trial account hard-blocks nested virt
  and the only unblock is a billing upgrade (the user's personal action) -> that is the genuine wall; record
  it honestly and adapt the substrate to what the environment truly permits. IN PROGRESS.
- A1 — Golden HOST image: base env baked (OS, runtimes, pkg caches/mirrors, Kata+Firecracker, OpenCode +
  three-agent stack, forging-egress + analysis stack). Warm small host. Static read runs on host.
- A2 — Detonation microVM via Kata/Firecracker: boots in ms, installs the project's own deps + runs it,
  isolation absolute, reset/destroyed per run, zero orphans, dead-man's switch. Containment proven.
- A3 — Deceptive forging egress (replaces sinkhole): forge C2/success responses so condition-gated malware
  unlocks; registry fast-path; capture/modify whole conversation; no real packet leaves. Proven safer.
- A4 — Rewire orchestrate + /api/deep to host+microVM; reuse stage-1 clone; keep milestones + forensics.
- B — Speed to real ~30s (warm pool, reuse, parallelize, fat pipe, per-phase timing). Measured proof.
- C — Real OpenCode + three parallel streaming agents + knowledge graph + cross-verify.
- D — Report precision/accuracy/content/presentation from design.md; forensics first-class.
- E — Whole-product: Lighthouse 95+, SEO, security, scalability/no-queueing, bloat-free, full-codebase audit.

Build new substrate ALONGSIDE the proven two-VM moat; prove containment on the new path BEFORE cutover;
never regress containment or U1-U5.

## A1/A2 PROVEN — a real container detonates in a Firecracker microVM via Kata (the riskiest fact)
On host `cr-host-build` (n2-standard-4, nested virt, Ubuntu 24.04), the full substrate installed + a real
container ran hardware-isolated in a Firecracker microVM:
- Stack: containerd v2.2.5 + devmapper snapshotter (thin-pool `cr-devpool`), Kata **3.32.0** (the static
  asset is `kata-static-3.32.0-amd64.tar.**zst**` — zstd, NOT .tar.xz; that was the 404), Kata BUNDLES
  firecracker+jailer+guest-kernel(`vmlinux.container`)+rootfs(`kata-containers.img`) and ships a preconfigured
  `/opt/kata/share/defaults/kata-containers/configuration-fc.toml`. mitmproxy 12.2.3 + CA installed.
- Wiring: `/etc/containerd/config.toml` (version=3) enables the devmapper snapshotter; a wrapper shim
  `/usr/local/bin/containerd-shim-kata-fc-v2` sets `KATA_CONF_FILE=configuration-fc.toml` and execs
  `containerd-shim-kata-v2`; `ctr run --snapshotter devmapper --runtime io.containerd.run.kata-fc.v2` boots
  the microVM (unpacks on demand — no separate `unpack` step).
- **PROOF (hardware isolation): host kernel = `6.17.0-1020-gcp`; the container's `uname -a` inside the microVM
  = `Linux ... 6.18.35 ... x86_64`** — a DISTINCT guest kernel. A runc/Docker container would show the host
  kernel; the different kernel proves a real Firecracker microVM, not a host namespace. The microVM substrate
  is REAL on this free-trial account. Containerd-2.x quirk learned: pulling with a non-default snapshotter
  needs platform context; `ctr run --snapshotter devmapper` handles unpack itself.
## A2 CONTAINMENT PROVEN (on cr-host-build)
- **Host-fs isolation ABSOLUTE:** a host marker `/root/CR_HOST_SECRET_MARKER` is "No such file or directory"
  inside the guest. Firecracker has no virtio-fs -> the microVM sees ONLY its block-device rootfs, never the
  host fs / static-read state / analysis brain. The spec's hardest isolation invariant: held.
- **No network egress by DEFAULT:** the guest has only `lo` (127.0.0.1); `wget example.com` -> "bad address".
  The microVM is network-isolated out of the box. => the forging egress (A3) is purely ADDITIVE: attach a tap
  wired ONLY to the host forge; never a default route to the real internet. (Better than the old sinkhole,
  which started from full DNAT-everything.)
- **Per-run reset:** ZERO orphan firecracker procs after `--rm` (blast-radius VMs cleaned). The "2 devmapper
  snapshots" are the reusable alpine image layers (correct), not containers. TODO(harden): 2 lingering
  `containerd-shim-kata` procs after multi-run — reap them for the zero-orphans invariant (a host-side
  cleanup sweep in the orchestrator, like the old VM_LEDGER sweep).

## A3 plan (next) — the deceptive forging egress (the spec's core correctness fix)
Refined by the no-default-network finding. Build egress UP through the forge:
1. mitmproxy forge addon (real code, sandbox/microvm/forge/): transparent mode; per-SNI leaf under the baked
   CA so non-pinning TLS clients complete the handshake + reveal payload; DNS -> answer every name with the
   forge IP; HTTP -> generic 200/canned; raw TCP/UDP -> accept + canned. `--ignore-hosts` allowlist
   (registry.npmjs.org|pypi.org|files.pythonhosted.org|crates.io|...) passed through + logged (real NAT).
2. Wire the microVM a tap (Kata CNI `tc-redirect-tap`, or a manual netns+tap) whose ONLY route lands in the
   host forge via TPROXY (TCP+UDP, preserves dst) / REDIRECT. Bake the mitmproxy CA into the detonation guest
   rootfs trust store.
3. PROVE: detonate a known-exfil fixture; the forge UNLOCKS its C2 beacon (captured plaintext, NO real packet
   leaves the host); a real `npm install` works via the registry fast-path; a cert-PINNING client aborts ->
   reported as an honest "encrypted C2 attempted, interception refused" signal (never a false clean).
Then A4: rewire orchestrate + /api/deep to host+microVM, reuse stage-1 clone, keep milestones+forensics,
browser proof; cut over only after containment >= the two-VM moat.

## Live status
- 2026-06-28: mandate received. Comprehended current arch + infra. Started A0 feasibility probe.
- **A0a RESULT — GREEN LIGHT (the load-bearing fact is YES):** on a `n2-standard-4 --enable-nested-virtualization`
  Ubuntu 24.04 VM, the probe confirmed `vmx` CPU flag, `/dev/kvm` present, `kvm-ok` = "KVM acceleration can be
  used", and Firecracker v1.16.0 installs + runs. **Nested virt + KVM + Firecracker all work on this free-trial
  account — NO billing-upgrade wall. The whole microVM substrate (A) is feasible.** The probe's microVM BOOT
  step failed only on a SCRIPT bug (my CI-artifact self-discovery from the S3 bucket returned empty keys ->
  downloaded listing XML not a real kernel; the `firecracker-ci/v1.16/` prefix doesn't exist — CI version is
  pinned separately from the release version). NOT an environment limit. Probe VM `cr-microvm-probe`
  (us-central1-a, auto-deletes ~30min) kept to re-run the boot with correct artifacts (A0b).
- **A0 CLOSED — feasibility PROVEN.** The load-bearing fact (can this account run hardware-isolated microVMs)
  is YES: nested virt + /dev/kvm + kvm-ok + Firecracker v1.16 all confirmed on the real account. The actual
  microVM-boot/detonation proof folds into A2 (proven via the real Kata stack, not a redundant standalone
  boot). Probe VM deleted.

## Research synthesis (commissioned, cited) — informs A1-A3
- **Substrate decision: BUILD KATA + FIRECRACKER per the spec** (containerd + devmapper snapshotter, the
  `io.containerd.kata-fc.v2` runtime). Research's honest engineering note: for a SINGLE-host bespoke harness,
  Firecracker-DIRECT (REST API + jailer + per-run netns/tap + CoW disposable rootfs + vsock telemetry +
  cgroup caps) is simpler and ~150-300ms faster to boot than Kata. I am NOT taking that shortcut: the spec
  explicitly names "Firecracker through Kata Containers" + emphasizes adherence to deliberate architecture,
  AND Kata is the documented path to the section-E K8s mass-scale. The boot-overhead delta is negligible vs
  the 30s budget. Recording the alternative here for transparency, not silently reinterpreting.
  - Kata specifics that shape the build: Firecracker has NO virtio-fs, so the container rootfs MUST be a
    block device -> containerd **devmapper snapshotter is mandatory** (thin-pool; loopback-backed pool does
    NOT survive reboot -> systemd oneshot to recreate, or back with a real block device). Pin Firecracker to
    Kata's manifest version (`versions.yaml assets.hypervisor.firecracker.version`), not "latest". Kata
    3.31.0. Networking: tap in a per-sandbox netns via the `tc-redirect-tap` CNI; host owns that netns ->
    apply egress controls there.
- **Deceptive forging egress (A3) — replaces the sinkhole:** mitmproxy transparent mode is the forging
  engine. Pre-bake mitmproxy's root CA into the golden detonation rootfs trust store; mitmproxy mints a
  per-SNI leaf on the fly so a NON-pinning TLS client completes the handshake and sends its real C2 payload.
  FakeNet-NG-style forging for DNS (answer every name with a controlled IP), HTTP (generic 200/canned body),
  raw TCP/UDP (accept + canned/dynamic response). Force ALL guest egress into the host forge via REDIRECT
  (TCP) or TPROXY (TCP+UDP, preserves original dst — needed for DNS/UDP C2 forging) inside the guest netns.
  Registry fast-path: mitmproxy `--ignore-hosts` regex allowlist (registry.npmjs.org, pypi.org,
  files.pythonhosted.org, crates.io, ...) -> passed through untouched + logged (their own pinning intact),
  real NAT egress; everything else forged.
  - HONEST LIMITS (must surface in the product, never overclaim): the forge unlocks plaintext + the ~92-99%
    of TLS clients that do NOT pin; it CANNOT beat cert-pinning, mTLS, or custom-crypto C2. Malware that pins
    (IcedID/AsyncRAT/DcRAT families, often self-signed) aborts the handshake -> that abort is itself a
    reportable signal ("attempted encrypted C2 to X; pinned, interception refused; behavior beyond not
    observed"), NEVER a false clean. Dovetails with the never-bare-"Safe" rail.
- Prior art to mirror: INetSim+PolarProxy, FakeNet-NG (Mandiant), Cuckoo/CAPE per-analysis `inetsim` routing.

## A1 plan (next) — prove the stack live, THEN bake the golden image
Order chosen for fastest real proof: install-and-detonate on a LIVE host first (prove the riskiest thing —
substrate + forging egress actually work + containment holds), THEN bake the golden HOST image (A1 proper,
the speed optimization). Steps: provision an n2 nested-virt host -> install Kata 3.31 + pinned Firecracker +
containerd + devmapper thin-pool + mitmproxy(+CA) + Node/Python runtimes + the detonation harness -> detonate
a benign test container AND a known-exfil fixture in a real Firecracker microVM with ALL egress forced through
the forging proxy -> prove: hardware isolation, the forge unlocks the exfil fixture's real beacon (captured,
no real packet out), registry fast-path lets a real npm install through, per-run reset + zero orphans. Then
bake the golden image. Containment re-proven on the new path BEFORE any cutover; the two-VM moat stays the
live path until the microVM path is proven >= it on safety.
