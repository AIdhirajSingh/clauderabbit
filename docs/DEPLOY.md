# Deploying ClaudeRabbit 2.0: the manual steps

ClaudeRabbit 2.0 is one Next.js app on Vercel. Every scan runs inside the Vercel function `POST /api/scan`, which
drives E2B sandboxes and the OpenAI model; Supabase holds the database, auth and Realtime. The exact env names
are in `docs/INFRASTRUCTURE.md` section 6, and the numbered key-day checklist (keys, template build, migrations,
smoke scans, labeled set, promotion) is in `docs/runs/2.0-backend.md`.

---

## Step 1: Vercel project and env

1. The Vercel project is `clauderabbit` (`prj_ovQlkpZsijvfky3oZNlg0txYvqA5`). Framework: Next.js, build
   `npm run build`.
2. Set the public values for Preview and Production: `NEXT_PUBLIC_SUPABASE_URL`,
   `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `NEXT_PUBLIC_SITE_URL`, and optionally `NEXT_PUBLIC_ADSENSE_CLIENT_ID`,
   `NEXT_PUBLIC_ADSENSE_SLOT_ID`, `NEXT_PUBLIC_ADSENSE_TEST`.
3. Set the server values: `OPENAI_API_KEY`, `E2B_API_KEY`, `SUPABASE_SECRET_KEY`, `CR_E2B_TEMPLATE`, and
   optionally `GITHUB_TOKEN`, `CR_OPERATOR_KEY`, `CR_MODEL_ID`, `CR_MODEL_REASONING_EFFORT`,
   `CR_DAILY_SANDBOX_SECONDS_CAP`, `CR_DAILY_MODEL_TOKENS_CAP`.
4. `/api/scan` and `/mcp` declare `maxDuration = 120`, inside the Hobby limit of 300 s.

## Step 2: E2B template

```bash
E2B_API_KEY=... npm run template:build
```

It prints `template_id=... build_id=... name=...` and fails on any build-time smoke check (forge redirect for uid
1001, envd port refused for uid 1001, fake clock speed, dependency postinstall runs). Set `CR_E2B_TEMPLATE` to the
printed name.

## Step 3: database

Apply the five 2.0 migrations on a non-production database first, then on production only after the owner
approves:

```bash
node scripts/db-branch-apply.mjs --ref <non-production-ref> --step roundtrip
```

The script refuses the production ref `mjvlczaytkhvsolnhhkz`. Production promotion is `supabase db push` against
the linked production project, run by the owner.

## Step 4: Supabase Auth redirect URLs (required for sign-in)

Google sign-in redirects back to `NEXT_PUBLIC_SITE_URL`, and Supabase only honors redirect URLs on its allowlist.
In the Supabase dashboard, **Authentication, URL Configuration**:

- **Site URL:** the production domain (`https://clauderabbit.in`).
- **Redirect URLs:** `https://<your-domain>/auth/callback`, `https://<your-domain>/**`, and
  `http://localhost:2311/auth/callback` for local dev. Add a Vercel preview origin here to sign in on a preview.

GitHub sign-in is intentionally not offered: V1 auth is Google and email only
(`components/spa/components/LoginForm.tsx`).

## Step 5: verify

```bash
curl -sN -X POST "$SITE/api/scan" -H 'content-type: application/json' -d '{"target":"expressjs/express"}'
```

The stream prints `{"type":"event",...}` lines for every stage and ends with one `{"type":"result",...}` line
whose `report.verdict` is never a bare "Safe", whose `report.not_verified` is non-empty, and which carries `ad`.
