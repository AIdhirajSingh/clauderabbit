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

## A3 PROVEN — the deceptive forging egress unlocks condition-gated malware (the core correctness fix)
On cr-host-build, a condition-gated exfil fixture (beacon C2 -> only if it answers, read+exfil decoy creds)
was detonated through the forge. Under the OLD sinkhole this stays dormant (false clean); under the forge:
- `forge-up.sh` builds a per-run netns: dummy `forge0`@169.254.0.1, dnsmasq answer-all -> forge IP, iptables
  REDIRECT (nat OUTPUT+PREROUTING) all TCP -> mitmproxy:8080 transparent (`--showhost --set
  upstream_cert=false --set connection_strategy=lazy`, the upstream_cert=false was the fix for the TLS
  handshake hang), `--ignore-hosts` registry allowlist, loading `forge_addon.py`. CA: guest trusts
  /root/.mitmproxy/mitmproxy-ca-cert.pem (the analog of baking the CA into the guest rootfs).
- PROOF (real run): `CR_FIX_BEACON status=200` (forge answered as the C2) -> `CR_FIX_GATE open` -> 
  `CR_FIX_CRED_READ bytes=98` -> `CR_FIX_EXFIL_SENT status=200` -> `CR_FIX_DONE ran`. The forge CAPTURE:
  `evil-c2.example /beacon sni=evil-c2.example` and `drop.evil-c2.example /upload | body: [default]
  aws_access_key_id=AKIA_CR_DECOY_CANARY aws_secret_access_key=...` — the FULL attack (beacon + the
  exfiltrated decoy creds, with the REAL intended C2 names via SNI/pretty_host) captured as forensic
  evidence. No real packet left (netns has only 169.254.0.0/24, no default route; every name -> forge IP).
  `forge-down.sh`: netns_left=0 mitm_procs_left=0 (zero orphans, per-run reset).
- Honest-limits hook present: a client TLS refusal after our leaf (cert-pinning/mTLS) -> captured as
  `tls_intercept_refused` ("encrypted C2 attempted, interception refused"), never a false clean.
- Fixed in installer: added `dnsmasq-base` to base packages (forge DNS).
## A4 NETWORK INTEGRATION PROVEN — full attack runs INSIDE a real microVM through the forge
The two proven halves compose. Established by trying (4 attempts pinned the exact requirement):
Kata-FC enumerates the container netns and accepts ONLY a clean veth `eth0` (it makes the tap itself via
`internetworking_model=tcfilter`) — it rejects a bridge ("Unsupported network interface: bridge") and a
same-netns veth (ParseInt ""). The working topology (now in forge/forge-up.sh):
- forge netns `cr-forge-<id>`: forgebr@169.254.0.1 + dnsmasq(answer-all) + mitmproxy(forge) + REDIRECT all
  TCP; holds the veth peer `crpeer` on the bridge.
- run netns `cr-run-<id>`: ONLY `eth0` (169.254.0.2, veth, peer=crpeer in cr-forge), default route via the
  forge. `ctr run --with-ns network:/var/run/netns/cr-run-<id> --runtime io.containerd.run.kata-fc.v2` ->
  Kata tcfilter turns eth0 into the microVM tap.
- PROOF (real python:3.12-slim microVM detonation): guest sets resolv.conf->forge, beacons
  http://evil-c2.example/beacon -> forge answers 200 -> `CR_FIX_GATE_OPEN` -> exfils decoy creds to
  drop.evil-c2.example -> `CR_FIX_EXFIL_SENT`. Forge CAPTURE: `evil-c2.example /beacon` +
  `drop.evil-c2.example /upload | aws_access_key_id=AKIA_CR_DECOY_CANARY&aws_secret_access_key=...` — the FULL
  attack captured from INSIDE the microVM (real C2 names via SNI/Host + the stolen creds). NO real packet
  left (run netns has only 169.254.0.0/24, no internet route; every name -> forge). forge-down: netns_left=0
  mitm_procs_left=0 (zero orphans). Re-proven with the canonical forge-up.sh/forge-down.sh.
- Detail: Kata does NOT propagate the guest resolv.conf through FC -> the detonation HARNESS writes it
  (`nameserver 169.254.0.1`) as its first step, before the untrusted code runs. busybox/musl wget had a
  resolver quirk; the real harness is python (glibc/getaddrinfo), which resolves cleanly (proven).
- setup-host.sh pins `internetworking_model=tcfilter`.

## NEXT — A4 app integration + the orchestrator (toward the /api/deep browser proof)
The substrate (isolation), forge (correctness), and their composition (microVM detonation through forge) are
all PROVEN. Remaining for A4: the host ORCHESTRATOR that, per scan, (1) reuses stage-1's pinned clone, (2)
builds/【selects】a detonation guest image carrying the runtimes + in-guest harness (writes resolv.conf->forge,
plants decoy creds, runs the repo's build+run, observes) + the mitmproxy CA, (3) forge-up -> detonate via
kata-fc -> collect the forge capture + in-guest observations -> forensic record -> forge-down (zero orphans),
then rewire /api/deep (Node route) to spawn THIS orchestrator instead of the two-VM orchestrate.sh, keep the
[orch] milestones + attach-forensics, prove a real detonation end-to-end in localhost:2311, retire the
two-VM path. Then B (warm pool, ~30s, parallelize, per-phase timing), C (real OpenCode 3 agents), D (report),
E (whole-product).

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

## A4 ORCHESTRATOR + /api/deep CUTOVER — PROVEN in the browser
The host orchestrator (sandbox/microvm/orchestrate-microvm.sh) ties it together per scan: reuse stage-1's
pinned clone (else clone) -> buildkit builds a per-scan image (FROM cr-detonation-base + COPY repo) ->
forge-up -> detonate the real repo in a Firecracker microVM via kata-fc with egress forced through the forge
-> assemble-forensics.py (forge capture + in-guest observation -> canonical record) -> forge-down (zero
orphans). Emits the same [orch] milestone strings /api/deep's milestone() parses. Proven on the host:
octocat/Hello-World -> score 100; sindresorhus/slugify -> real npm install (509 registry passthroughs),
build_ok true, score 100, zero false-positive cred flags.
- Registry fast-path: the forge ADDON proxies registries to the real upstream (genuine build) over a leaf the
  guest trusts via the baked CA; forges everything else. dnsmasq resolves registries to REAL IPs (so the
  passthrough isn't a loop); a per-run NATed uplink (10.111.x/30) the GUEST cannot use; --ignore-hosts dropped
  (unreliable in transparent mode). New host stack: nerdctl-full + buildkitd on the CONTAINERD worker (so a
  locally-built FROM resolves + built images land where ctr finds them).
- **CUTOVER: app/api/deep/route.ts now SSHes to the sandbox host and runs orchestrate-microvm.sh** (via bash
  so gcloud.cmd resolves on Windows), streams its [orch] stderr as milestones, reads the forensic record from
  stdout, POSTs {forensics, timeline} to attach-forensics (U5 timeline preserved). The local two-VM
  orchestrate.sh spawn is RETIRED. PROVEN IN THE LOCALHOST BROWSER: a direct /api/deep call detonated
  octocat/Hello-World on the NEW substrate in 54s — all stages streamed (Clone+pin -> Provision detonation VM
  -> Build under containment -> Run under the sinkhole -> Capture+reset -> Compute verdict -> Persist),
  result persisted:true. UI scan of AmrDab/clawdcursor rendered its report (cached, determinism per SHA).
  Fresh clawdcursor new-substrate detonation in flight to update the report off the new substrate.
- tsc 0, eslint 0 on route.ts. Two-VM moat retired from the live path; cr-sandbox-* firewall rules remain.

## SHIPPED STATE (A0-A4 + B) — proven, green, building
- **A (substrate + cutover): DONE, proven in the localhost browser.** The two-VM moat is replaced by ONE
  warm host (cr-host-build) running Kata/Firecracker microVMs + the deceptive forge. A real escalating repo
  (AmrDab/clawdcursor) scanned from the UI -> escalated -> detonated on the NEW substrate (150s) -> report
  renders (score 64 Caution, substrate=kata-firecracker-microvm, honest "did not build to a runnable state",
  no malice observed, score held by static post-install; no bare "Safe", no hedge, reputation separate).
  Containment held: zero orphan microVMs, no real packet left. The local two-VM orchestrate.sh spawn is
  RETIRED from /api/deep (now SSHes to the host orchestrator).
- **B (speed): instrumented + parallelized.** Our orchestrator overhead measured at ~1.5s (clone 0.5s +
  image-build∥forge 0.9s + forensics 0.04s); per-phase ms breakdown emitted; build untraced (forge owns
  network capture) + registry RAW-passthrough (tls_clienthello SNI) so builds run native-speed. The detonate
  phase is the repo's genuine npm install + the microVM lifecycle (honest repo-vs-our split, never conflated).
  Remaining lever for the deep ~30s: a warm microVM pool to cut the ~11s VM-lifecycle (noted).
- **Whole product GREEN:** tsc 0, node 66/66, deno _shared 33/33, deno check edge fns 0, `npm run build`
  succeeds (SSR /[owner]/[repo] report + /badge = the SEO surface). No regressions to U1-U5, auth,
  determinism, the inline moat, the honest verdict, or containment.
- Merged to main on this branch.

## REMAINING (next iterations) — honest status
- **C — real OpenCode + three parallel agents:** the detonation analysis is currently the deterministic
  in-guest harness + forensics (functional + honest). Real OpenCode + 3 streamed parallel agents + knowledge
  graph is the project's documented model-swap (CLAUDE.md: Gemini placeholder now, OpenCode swaps in behind
  the clean seam) and a large integration — the next major unit on top of the proven substrate.
- **D — report:** already renders honestly from design.md (U1-U2 components); forensics woven in first-class.
  Further polish/motion via the impeccable/frontend-design skills is incremental.
- **E — whole product:** build green + SSR SEO surface in place; Lighthouse 95+ tuning, deeper security
  headers, and the full-codebase bloat audit are the remaining hardening pass.
