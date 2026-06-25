# Claude Rabbit — Dynamic Sandbox Engine (the moat)

> Everyone reads the code. We run it.

This is the deep-path engine: it clones, builds, runs, and **observes** an unknown
repository on a real, throwaway Google Cloud VM, hermetically isolated and reset
after every scan. The fast path (the `scan` edge function) escalates here when it
sees something it can't resolve (obfuscation, install-time network, credential
access, a brand-new owner, or low read-confidence).

## Architecture

| Piece | File | Role |
|---|---|---|
| Golden image | `golden-image/build-image.sh`, `startup-provision.sh` | Bakes Node, Python, build tools, and the harness into a reusable GCP image (`cr-sandbox-golden` family) so an ephemeral VM boots ready with **zero egress needed**. |
| Hermetic network | `net/setup-network.sh` | Creates `cr-sandbox-vpc` with an **EGRESS deny-all** firewall (`cr-sandbox-deny-egress`) + IAP-only SSH ingress. VMs get **no external IP**. |
| Observer | `harness/observe.py` | The "watch what it does" half. Real `strace -f` of the process tree: outbound `connect()`/DNS (blocked → the block is the signal), reads of **decoy** credential paths (`~/.ssh`, `~/.aws`, `~/.npmrc`, tokens, history — planted canaries, **no real secrets**), execs, files dropped, and CPU-cores-busy (mining). Records **facts only**, no verdict. Enforces `ulimit` CPU/file/proc caps + a hard `timeout`. |
| Harness | `harness/run-harness.sh` | Split-phase prepare → build → run → merge, each wrapped by the observer, egress locked throughout. |
| Verdict | `verdict.py` | Turns the behavior facts into an honest dynamic verdict. **Never a bare "Safe."** Distinguishes high-value credential theft from legitimate tool config reads (so a clean `npm install` is not mislabeled). |
| Orchestrator | `orchestrate.sh` | Runs ONE scan end to end: ensure network → boot ephemeral VM from the golden image (no external IP, `--no-service-account --no-scopes`) → verify egress is blocked with a control probe → stage repo+harness over IAP SSH → build+run under observation → collect behavior → compute verdict → **delete the VM (the per-scan reset)** via a `trap` on every exit path. |

## The two safety rails (both enforced here)

1. **Hermetic + reset every scan.** No external IP, no service account/scopes, no real
   credentials (only decoys), egress denied by firewall, resource caps, and the VM is
   **deleted after every scan**. A caught attack hits an empty room about to be demolished.
2. **Never a bare "Safe."** Every verdict shows the evidence and a `not_verified` list
   (e.g. "condition-triggered behavior that did not fire during our run would not be observed").

## Proven on live GCP (synthetic fixtures, authored locally — never published)

| Fixture | Build | Verdict | Key observations |
|---|---|---|---|
| `fixtures/cred-stealer` | ok | **0 / Dangerous** | 5 high-value credential reads (decoys) + outbound **blocked by egress lockdown** + exfiltration pattern |
| `fixtures/miner` | ok | **0 / Dangerous** | credential reads + blocked outbound + **~1.08 cores pinned (mining)** |
| `sindresorhus/yocto-queue` (benign real repo) | blocked* | **Clean run** (honest) | no malicious behavior; honestly notes the run did not complete because egress lockdown blocked `npm install` |

\* See the tradeoff below. The reproduction run by the lead (`credproof`) re-confirmed the
cred-stealer result end to end and that the ephemeral VM was deleted (reset proven).

## Measured numbers (honest, small real samples — measure before over-investing)

- **Auto-build success under full egress lockdown:** self-contained repos (no external
  deps) build and run unattended; repos that must fetch dependencies (`npm install`,
  `pip install`) **do not complete** because egress is denied during the build phase.
  This is a deliberate isolation-over-convenience choice. **Next step to raise this
  number without weakening isolation:** a controlled, registry-allowlisted dependency
  -fetch phase (npm/PyPI mirror or a tightly-scoped egress window during build only),
  then re-lock for the run phase.
- **Escalation rate (fast path, real scans):** the gate escalated `zloirock/core-js`
  (install-time `postinstall` + network) and passed clean utilities (is-plain-obj,
  yocto-queue, p-limit, p-map, escape-string-regexp) on the fast path — ~1 in 6 on this
  tiny sample. The ~5% target is a tuning goal; the sample is too small to confirm it,
  but the gate fires correctly on the right signals.

## Run it

```bash
# malicious fixture (local tarball)
bash sandbox/orchestrate.sh --zone us-central1-a --tarball ./sandbox/fixtures/cred-stealer.tar.gz --name cred-stealer
# a real public repo
bash sandbox/orchestrate.sh --zone us-central1-a --github sindresorhus/yocto-queue --name yocto
```

The VM is always deleted on exit (success, failure, or interrupt). Run artifacts
(`results/`, `.work*/`, staged `*.tar.gz`) are gitignored.
