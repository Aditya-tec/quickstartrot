# Deploying the API (Render free tier)

The API (`apps/api`) runs as one free Render web service, built from `render.yaml`. It talks to the Supabase
Postgres database that already exists, and to Supabase Storage for logs and diffs. This file lists the steps in order. Environment variables are listed
by **name only**; values are never written in this repository.

## Before you start

You need: the GitHub repo (this one), the Supabase project (database already migrated), a Groq API key
(optional, see step 3) and a Render account.

Generate the four random secrets once, on your own machine (each run prints a different value; save them in a password manager):

```
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

You need three different values for `INGEST_HMAC_SECRET`, `ADMIN_TOKEN` and `SUBMISSION_IP_SECRET`
(a fourth for `REVALIDATE_SECRET` when the web app exists, phase P8). Never reuse one for two purposes.

## 1. Create the Supabase Storage buckets

Supabase dashboard → **Storage** → **New bucket**:

| Bucket              | Public? | Holds                                    |
| ------------------- | ------- | ---------------------------------------- |
| `public-artifacts`  | **yes** | redacted step logs, docs diffs (30 days) |
| `private-artifacts` | **no**  | Playwright traces (14 days)              |

The API creates signed upload URLs for runners, so the runners never see a Supabase credential.

## 2. Collect the Supabase values

Supabase dashboard → your project:

- **`DATABASE_URL`**: **Project Settings → Database → Connection string → Transaction pooler** (host `…pooler.supabase.com`,
  port **6543**). Replace `[YOUR-PASSWORD]` with the database password. Use the pooler, not the direct connection: Render's free tier is
  IPv4-only and the direct host is IPv6. (The API disables prepared statements, which the transaction pooler requires.)
- **`SUPABASE_URL`**: **Project Settings → API → Project URL** (`https://<ref>.supabase.co`).
- **`SUPABASE_SERVICE_ROLE_KEY`**: **Project Settings → API → service_role** key. This key bypasses row-level security: it is set on Render
  only, never in GitHub, never in the web app.

## 3. Create the Render service from the Blueprint

1. Render dashboard → **New → Blueprint** → connect the GitHub repo `Aditya-tec/quickstartrot` → branch `main`.
2. Render reads `render.yaml` and shows one service, **quickstartrot-api** (free plan). Choose the region closest to your Supabase project.
3. Render asks for every variable that `render.yaml` declares with `sync: false`. Fill them in as follows
   (a variable left empty is treated as "not set"; the defaults apply):

| Variable                    | Required | Value                                                                                     |
| --------------------------- | -------- | ----------------------------------------------------------------------------------------- |
| `DATABASE_URL`              | yes      | transaction pooler URL (step 2)                                                           |
| `INGEST_HMAC_SECRET`        | yes      | random secret #1 (16+ chars); the same value goes to GitHub Actions (step 5)              |
| `ADMIN_TOKEN`               | yes      | random secret #2 (16+ chars); used as `Authorization: Bearer …` on `/admin/*`             |
| `SUBMISSION_IP_SECRET`      | yes      | random secret #3 (16+ chars)                                                              |
| `GROQ_API_KEY`              | no       | from console.groq.com. Without it every compile cache miss answers `deferred`             |
| `GROQ_DAILY_TOKEN_BUDGET`   | no       | default `150000` (the free tier allows 200000 tokens a day)                               |
| `COMPILER_MODEL`            | no       | leave empty for the default                                                               |
| `SUPABASE_URL`              | yes\*    | step 2. \*Without it, `/internal/uploads` and `/admin/gc` answer 503                      |
| `SUPABASE_SERVICE_ROLE_KEY` | yes\*    | step 2                                                                                    |
| `WEB_ORIGIN`                | no       | your Vercel domain, e.g. `https://quickstartrot.vercel.app` (comma separated for several) |
| `REVALIDATE_URL`            | no       | the web app's revalidation endpoint; leave empty until phase P8                           |
| `REVALIDATE_SECRET`         | no       | leave empty until phase P8                                                                |
| `TURNSTILE_SECRET`          | no       | enables the CAPTCHA check on `POST /submissions`; leave empty to run without it           |
| `COMPILE_TIMEOUT_MS`        | no       | default `100000`                                                                          |
| `RATE_LIMIT_PER_MINUTE`     | no       | default `120`                                                                             |
| `LOG_LEVEL`, `TRUST_PROXY`  | no       | defaults `info` and `true`                                                                |

`NODE_VERSION` (22) and `NODE_ENV` (production) are fixed in `render.yaml`.

4. Click **Apply**. The first build takes 3-6 minutes (`pnpm install --frozen-lockfile && pnpm --filter api... build`).
   The service is live when the dashboard shows **Live** and the health check (`/health`) is green.

If the build log says `pnpm: command not found`, change the service's **Build Command** (Settings) to
`corepack enable && pnpm install --frozen-lockfile && pnpm --filter api... build` and redeploy.

## 4. Find the service URL

Render dashboard → **quickstartrot-api** → the URL under the service name, of the form
`https://quickstartrot-api.onrender.com` (the exact subdomain may carry a suffix if the name was taken).
Open `<url>/health`: it should answer `{"status":"ok","db":true,"time":"…"}`.

## 5. Tell GitHub Actions where the API is

GitHub repo → **Settings → Secrets and variables → Actions**:

- **Variables** tab → **New repository variable**: `API_BASE_URL` = the URL from step 4 (no trailing slash). This is not a secret.
- **Secrets** tab → **New repository secret**: `INGEST_HMAC_SECRET` = the same value as on Render. (The probe pipeline in phase P7 reads
  it in the `plan` and `report` jobs only; the `execute` job never gets secrets.)

## 6. Verify with the smoke script

On your machine, in the repo root, with the **same** `INGEST_HMAC_SECRET` as on Render exported in the shell (it is read
from the environment, never from the command line):

```
# PowerShell
$env:INGEST_HMAC_SECRET = "<secret #1>"
pnpm smoke:api --url https://quickstartrot-api.onrender.com
```

Expected output (six PASS lines, exit code 0):

```
PASS  wake - answered after 38 s (5 tries)
PASS  /health - status=ok db=true time=…
PASS  signed POST /internal/cycles - cycle … (created=true, N enabled tools)
PASS  bad signature - expected 401, got 401
PASS  stale timestamp - expected 401, got 401
PASS  admin without token - expected 401, got 401
```

The signed POST creates (once) a harmless cycle row with `git_sha = smoke-test` and `gh_run_id = 1`; repeated runs reuse it.
The first `wake` line is the cold start described below.

Then sync the targets into the database (the probe pipeline does this itself from phase P7):
the first real cycle needs the `tools` table to be populated.

## What a cold start looks like

Free Render instances stop after **15 minutes without a request**. The first request after that is held while the
instance boots: typically **30-60 s**, sometimes longer, and a `503` from Render's proxy may appear meanwhile. This is expected and handled:

- `wakeApi()` in the CLI client calls `GET /health` every 10 s for up to 3 minutes before a cycle starts, and fails with a message naming
  `API_BASE_URL` if the API never answers.
- Every `/internal/*` call retries 502/503/504 and network errors with exponential backoff (2, 4, 8, 16, 30, 30 s), re-signing each attempt.
- `/internal/runs` and `/internal/cycles` are idempotent, so a retry never double-counts.

The nightly cycle runs well inside the 750 free instance-hours a month. The public pages do not depend on the API; only
the submission form does, and it is merely slower while the API wakes.

## Rotating a secret

Change it on Render (Environment → edit → the service redeploys), and change the GitHub Actions secret to match for `INGEST_HMAC_SECRET`.
Requests signed with the old value are refused with 401 until both match.

## First real probe run

Do this after the smoke script (step 6) passes. The first run uses three real tools, so a problem is cheap to find.

### What must be set first

| Where                                               | Name                 | Kind     | Needed by         | Value                                                                                     |
| --------------------------------------------------- | -------------------- | -------- | ----------------- | ----------------------------------------------------------------------------------------- |
| GitHub → Settings → Secrets and variables → Actions | `INGEST_HMAC_SECRET` | secret   | plan, report      | the same value as on Render (step 5)                                                      |
|                                                     | `API_BASE_URL`       | variable | plan, report      | the Render URL, no trailing slash (step 5)                                                |
|                                                     | `SUPABASE_ANON_KEY`  | variable | report, snapshot  | the PUBLIC anon key (Supabase → Project Settings → API). Not the service-role key         |
|                                                     | `SUPABASE_URL`       | variable | snapshot          | `https://<ref>.supabase.co`                                                               |
|                                                     | `WEB_BASE_URL`       | variable | report (optional) | the Vercel URL once the site exists (phase P8); until then run ids are shown as short ids |

Never add the service-role key, the Groq key or the admin token to GitHub: only the API (Render) holds them.
The **execute** job reads no secret and no variable at all; a test fails the build if it ever does.

Also check:

- Storage buckets `public-artifacts` and `private-artifacts` exist (step 1). Log uploads go to the first.
- Apply the pending database migration from your machine: `pnpm --filter @qsr/db db:migrate`
  (it adds `0005_public_pass_rate`: the public pass rate ignores runs that never reached the executor).
- Optional: create an issue label named `harness` (red). It is created automatically the first time an issue is opened.

### Run it

GitHub → **Actions** → **probe** → **Run workflow** → in `only` put three slugs, for example

```
chalk-node,dotenv-python,resend-node
```

(or with the GitHub CLI: `gh workflow run probe.yml -f only=chalk-node,dotenv-python,resend-node`).
The four canaries always run in addition, because a cycle without them is invalid. A cold start adds up to a minute at the
beginning of the plan and report jobs.

### What a healthy run looks like

The `plan` job summary lists each tool as `ready`. The `execute` jobs (one per shard) each print how many tools ran. The
`report` job summary looks like this:

```
### Probe cycle 5d1b8c1e-...: valid

3 passed, 0 failed (3 tools, 4 canaries)

| Tool            | Level   | Outcome | Class | Duration | Plan | Run      |
| ---             | ---     | ---     | ---   | ---      | ---  | ---      |
| chalk-node      | L3 / L3 | PASS    |       | 4.1 s    |      | 0f9d2c1e |
| dotenv-python   | L3 / L3 | PASS    |       | 9.8 s    |      | 7a31b0c2 |
| resend-node     | L3 / L3 | PASS    |       | 5.6 s    |      | c8e4d210 |
| canary-fail-dep | L0 / L3 | FAIL    | DEPENDENCY_RESOLUTION | 3.2 s | |  ...     |
...
```

The canaries `canary-fail-*` show **FAIL**; that is their expected answer and the cycle is still **valid**. In the database
(Supabase → Table editor) there is one new `probe_cycles` row with `valid = true` and `finished_at` set, one `runs` row per
tool, and `step_results` rows whose `log_path` points into `public-artifacts`.

Things that are normal on a first run: `stale plan` is not shown (the model was asked), a tool may show `SKIPPED` with
`deferred: llm_budget` if the day's Groq budget is spent, and a pre-failed tool shows `CRAWL_ERROR` or `COMPILER_ERROR` in
`Class` with the reason in `Plan`. None of these change a tool's status.

### If it fails, send me

1. The link of the Actions run.
2. The **summary** of the failing job (the text under "Summary" at the top of the run page), copied as text.
3. The last 40 lines of the failing step's log (click the red step). If the red job is `execute`, also say which shard.
4. If `report` failed: the Render log lines around that time (Render → your service → Logs), filtered by the word `internal`.
5. If a canary shows the wrong result: the downloaded artifact `results-0` (Actions run page → Artifacts), unzipped,
   the file for that canary.

Do not paste secrets. Logs never contain them (they are redacted twice), but check before you paste.

Quick diagnosis:

| Symptom                                                           | Likely cause                                                                                              |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `plan` fails with "did not wake up within 3 minutes"              | the Render service is not running, or `API_BASE_URL` is wrong                                             |
| `plan`/`report` fail with 401                                     | `INGEST_HMAC_SECRET` differs between GitHub and Render                                                    |
| `report` warns "log upload was refused" (runs are still recorded) | Storage buckets missing, or the gateway wants a key: set the variable `SUPABASE_ANON_KEY`                 |
| Summary says the cycle is **INVALID**                             | a canary behaved differently; the summary names which. No status was changed. A `harness` issue is opened |
| A `harness` issue appears with "harness error rate"               | more than 5% of tools produced no result (a shard crashed or timed out); re-run, then send me the logs    |
| `execute` fails with "Docker is not reachable"                    | a GitHub runner problem; re-run the failed job                                                            |
