# Sunlink production-readiness — pre-session rollback snapshot (2026-07-09)

Known-good restore point captured **before** any change in the Sunlink production-readiness sweep.
If the sweep goes wrong, restore to this state and diagnose from safety.

## Git

- **Rollback tag:** `pre-sunlink-production-readiness-known-good` → commit `5aadcc2` (`main` HEAD at session start, PR #105 merged).
- Prior known-good tags remain: `pre-cloud-run-migration-known-good`, `single-host-dispatch-known-good`.
- Working branch for this session: `claude/sunlink-production-readiness-3a6353`.
- To roll back: `git reset --hard pre-sunlink-production-readiness-known-good`.

## Supabase

- **Linked project ref:** `mjvlczaytkhvsolnhhkz` (name: `clauderabbit`, org `jnahpffanbkulssznima`).
- **Schema state:** 15 migrations applied, latest `20260704000003_verify_cli_token_anon.sql`.
- Any new migration this session is additive and forward-only; no existing migration is edited.
- Edge functions deployed: `scan`, `deep-queue`, `attach-forensics`, `oauth-token` (+ `_shared`).

## GCP / Cloud Run (per docs/INFRASTRUCTURE.md — authoritative facts there)

- Dynamic sandbox substrate is **Cloud Run Jobs** (migrated from the Kata/Firecracker microVM
  approach, which is retained under `sandbox/microvm/` as superseded). Current path: `sandbox/cloudrun/`.
- The forge gateway + harness image are provisioned via `sandbox/cloudrun/**` scripts.
- NOTE: `gcloud` is unavailable in this session's shell (Python not installed), so live Cloud Run
  config was not re-read via CLI. The authoritative config lives in `docs/INFRASTRUCTURE.md`; no
  GCP/Cloud Run resource is mutated from this session — sandbox changes here are source-only and
  validated by unit tests + the live production deep path, not by re-provisioning infra.

## Environment (this session)

- Node 24.16, npm 11.13, Deno 2.9.1, Vercel CLI 54.20, Supabase CLI 2.105 — present.
- Python / gcloud — NOT available.
- Network reachable: GitHub API, npm registry, `clauderabbit.in` (live 200), Supabase.
