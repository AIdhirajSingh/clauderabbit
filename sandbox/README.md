# Claude Rabbit — Dynamic Sandbox Engine (the moat)

> Everyone reads the code. We run it.

This is the deep-path engine: it clones, builds, runs, and **observes** an unknown
repository on a real, throwaway Google Cloud VM, hermetically isolated and reset
after every scan. The fast path (the `scan` edge function) escalates here when it
sees something it can't resolve (obfuscation, install-time network, credential
access, a brand-new owner, or low read-confidence).

It is a **monitored sinkhole**, not a black box: it lets the code do what it would
do, watches ALL of it, but **never lets a single real packet reach a real
destination**. During BUILD the detonation VM may fetch declared dependencies from
package registries ONLY (through an allowlist proxy on a controlled host), so
normal repos actually `npm install`/`pip install` and build. During RUN every
outbound call — DNS and connections, even to a hardcoded IP — is intercepted and
redirected to a controlled internal TRAP that records the full intent (domain,
intended IP, geo, the would-be payload captured inert) and answers so the code
believes it succeeded. The intended destination is never reached.

## Architecture

| Piece | File | Role |
|---|---|---|
| Golden image | `golden-image/build-image.sh`, `startup-provision.sh` | Bakes Node, Python, build tools, and the harness into a reusable GCP image (`cr-sandbox-golden` family) so the detonation VM boots ready. |
| Hermetic network | `net/setup-network.sh` | `cr-sandbox-vpc`: **EGRESS deny-all** (`cr-sandbox-deny-egress`, pri 1000 — the fail-closed backstop) + a **subnet-only egress allow** (`cr-sandbox-allow-subnet-egress`, pri 800, dst `10.200.0.0/24` ONLY) so the detonation VM can reach the intra-VPC trap but nothing on the internet + a trap-ingress allow (intra-VPC only) + IAP SSH. Detonation VMs get **no external IP, no service account/scopes**. |
| Trap / control host | `net/trap-host.sh`, `harness/sinkd.py` | The controlled internal destination + the **external tamper-proof monitor**. Runs **dnsmasq** (answers EVERY query with the trap's own private IP), a **catch-all TCP/TLS/HTTP sink** (`sinkd.py` — accepts any connection on any port, terminates TLS extracting SNI, records SNI/Host/path/payload **inert**, answers 200 so the client believes success), a **registry-allowlist build proxy** (squid — npm/PyPI ONLY, default-deny, CONNECT/IP-literal closed), and a **tcpdump pcap** (the trustworthy network record that survives if the detonation VM is owned). Containment-hardened: `ip_forward=0`, `FORWARD` policy DROP, **no MASQUERADE** — it terminates, it never forwards. |
| Sinkhole flip | `harness/sinkhole-flip.sh` | Runs on the detonation VM (root) to switch from BUILD to RUN: rewrites `/etc/resolv.conf` to the trap ONLY, and installs `iptables` OUTPUT/nat **DNAT of ALL outbound TCP/UDP → trap private IP** (original port preserved). Locally-generated packets hit OUTPUT(nat) **before** egress evaluation, so even a hardcoded-public-IP connect is rewritten to a trap address — caught by pri-800, and anything the DNAT misses dies at pri-1000. Asserts containment and **aborts the run** if the DNAT/resolv.conf are not in place. |
| Observer | `harness/observe.py` | The in-VM "watch what it does" half. Real `strace -f`: outbound `connect()`/DNS (now **classified `sinkholed`** when redirected to the trap = an intercepted egress attempt, distinct from blocked/private), reads of **decoy** credential paths (canaries, **no real secrets**), execs, dropped files, CPU-cores-busy. Records **facts only**. `ulimit` + hard `timeout`. |
| Harness | `harness/run-harness.sh` | Split-phase prepare → **build (via trap proxy)** → **run (under sinkhole)** → merge, each wrapped by the observer. |
| Off-VM analysis | `analysis/analyze-payload.py`, `analysis/run-analysis.sh` | The **separate, disposable, isolated** payload analysis (never the detonation VM, never persistent). Inert captured bytes only: decode payloads, **resolve intended IPs (intelligence only, never routed)**, GeoIP them off-VM, and AI-analyze with **Gemini via Vertex (ADC)** into the forensic record. `local` mode = throwaway dir on the orchestrator host; `vm` mode = a distinct disposable analysis VM (auto-deleted). |
| Verdict | `verdict.py` | Honest dynamic verdict. **Never a bare "Safe."** A **caught (sinkholed)** exfil/beacon is scored **maximally dangerous** with the captured destination named; a merely-blocked attempt is still flagged; a clean run is "no malicious behavior observed", never "Safe". |
| Forensics | `harness/forensics.py`, `harness/persist-forensics.sh` | Fuses in-VM behavior + trap capture (external) + off-VM analysis + verdict into one structured **forensic JSON** (`claude-rabbit/forensic-record@1`): what ran, network intent (domains/intended IPs/geo), inert attempted-exfil payloads, in-VM behavior, the verdict, the containment proof, and an honest `not_verified`. `persist-forensics.sh` writes it to a report row via the service-role `attach_forensics` RPC (migration `…_forensics.sql`). |
| Orchestrator | `orchestrate.sh` | Runs ONE scan end to end: network → **trap host** → **detonation VM** (no IP, no SA) → stage → **build via proxy** → **control probe (must be contained)** → **flip to sinkhole + run** → collect behavior + trap capture → **delete detonation VM** → **isolated analysis** → verdict + forensics → **delete trap**. Ends with **no VMs**. |

## Bulletproof cleanup (the prior run orphaned a VM)

Bash traps do **not** run on SIGKILL/power-loss — the likely cause of the prior
orphan. So every VM is booted with **`--max-run-duration=30m --instance-termination
-action=DELETE`**: a **server-side dead-man's switch** that deletes the VM even if
the orchestrator process dies. On top of that: VM names are recorded to a ledger
**before** create, an EXIT/INT/TERM trap deletes every recorded VM and verifies it
is gone, and a final prefix sweep (`cr-sbx-`/`cr-trap-`/`cr-analysis-`) removes any
straggler. The deep-path run ends with `gcloud compute instances list` **empty**.

## Double containment (the network invariant)

> Never let a single real packet reach a real destination — as absolute as "never a bare Safe."

- **Layer 1 (VPC firewall, fail-closed):** the detonation VM has no external IP and a
  deny-all egress rule (pri 1000) to `0.0.0.0/0`. The only egress it gets is the
  pri-800 allow to the subnet (`10.200.0.0/24`) — i.e. to the trap. Nothing reaches
  the internet, period. This holds even if Layer 2 is bypassed.
- **Layer 2 (in-VM DNAT):** every outbound TCP/UDP from the untrusted code is DNAT'd
  to the trap's private IP before it leaves the NIC, so a hardcoded-IP connect is
  ALSO redirected to the trap. The trap terminates locally and **never forwards**
  (`ip_forward=0`, FORWARD DROP, no MASQUERADE).
- **Proof:** a control probe to a real host (`https://example.com`) from the
  detonation VM must NOT succeed; the trap's capture + pcap independently show the
  attempt was absorbed; the intended IP is resolved only OFF-VM, never routed to.

## The two safety rails (both enforced here)

1. **Hermetic + reset every scan.** No external IP, no service account/scopes, no real
   credentials (only decoys), egress denied to the internet by firewall, all egress
   sinkholed during run, resource caps, and the VM is **deleted after every scan**.
   A caught attack hits an empty room about to be demolished.
2. **Never a bare "Safe."** Every verdict shows the evidence and a `not_verified` list.
   Code that stayed dormant (suspecting a trap, or condition-gated) is reported as
   **UNVERIFIED**, never clean — absence of captured malice is not a clean bill.

## Synthetic fixtures (authored locally — NEVER published)

All emulate attack *shapes*; none is real malware.

| Fixture | Source | Emulates |
|---|---|---|
| `fixtures/exfil-c2` | `index.js` | RUN-phase credential exfil: resolves `exfil.evil-c2.example` and HTTPS-POSTs decoy "loot". The sinkhole proof. |
| `fixtures/cred-stealer` | `scripts/postinstall.js` | Install-time supply-chain exfil (postinstall reads creds + exfils + `eval(atob())` obfuscation). |
| `fixtures/miner` | `index.js` | Crypto-miner: pins CPU + beacons a mining pool. |
| `fixtures/benign-deps` | `package.json` deps | A genuinely benign repo with a real npm dependency — proves the controlled-build proxy actually installs deps and builds, then runs clean. |

Build them: `bash sandbox/fixtures/build-fixtures.sh` (the `*.tar.gz` are gitignored).

## Proven on live GCP (project `gen-lang-client-0062239756`, us-central1-a)

| Fixture | Build | Verdict | What the sinkhole proved |
|---|---|---|---|
| `exfil-c2` | ok | **0 / Dangerous** | Control probe to `https://example.com` from the detonation VM **timed out (`000 rc=28`) — contained**. The trap intercepted the HTTPS POST, captured SNI/Host `exfil.evil-c2.example`, path `/collect?id=victim-001`, and the would-be payload **inert** (decoded to the decoy canary creds). The Gemini-via-Vertex analysis correctly called it credential exfiltration. **No packet reached the real destination.** |
| `benign-deps` | ok (`npm install leftpad` via the registry proxy) | **100 / Clean run** | Deps fetched + built through the allowlist proxy (the auto-build improvement), then ran clean under the sinkhole. Verdict is honest "no malicious behavior observed" — never "Safe"; the build-phase package-manager connections are noted as dependency-fetch, not flagged as malice. |

Both runs ended with the detonation VM deleted mid-run and the trap deleted at the end —
`gcloud compute instances list` **empty**. Double containment held both times
(deny-1000 firewall + iptables DNAT to the trap, trap `ip_forward=0`/FORWARD DROP/no NAT).

**Measured auto-build success:** **5/6** node fixtures/repos built unattended on live runs
(the controlled-build proxy is what lets dependency-fetching repos like `benign-deps` build —
under the old full-lockdown they could not). Honest, small sample; the proxy raises this number
without weakening isolation (the detonation VM still has no direct internet egress).
**Escalation rate** is determined by the fast-path gate (separate edge function); the deep
sinkhole is the ~5% escalated path. Measure both on larger real samples before over-investing.

## Run it

```bash
# synthetic exfil fixture (the sinkhole proof)
bash sandbox/orchestrate.sh --zone us-central1-a --tarball ./sandbox/fixtures/exfil-c2.tar.gz --name exfil
# benign dependency-fetching repo (the controlled-build proof)
bash sandbox/orchestrate.sh --zone us-central1-a --tarball ./sandbox/fixtures/benign-deps.tar.gz --name benign
# a real public repo
bash sandbox/orchestrate.sh --zone us-central1-a --github sindresorhus/yocto-queue --name yocto
```

Every VM is deleted on exit (success, failure, interrupt, or even SIGKILL — via the
server-side `--max-run-duration … DELETE`). Run artifacts (`results/`, `.work*/`,
staged `*.tar.gz`) are gitignored. Measured auto-build success and escalation-rate
numbers from the live runs are recorded in `results/` per run.
