# @qsr/api

The only package that writes to the database (spec sections 4 and 11). A Fastify 5 service with the Zod type
provider, deployed to Render's free tier (see [DEPLOY.md](../../DEPLOY.md)). The pure libraries (`crawler`,
`compiler`, `executor`, `classifier`, `status`) are injected into it; runners never hold database credentials.

## Endpoints

| Route                                      | Auth       | Purpose                                                                                                                             |
| ------------------------------------------ | ---------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`                              | none       | `{status, db, time}`; used by Render and by `wakeApi()`                                                                             |
| `POST /submissions`                        | rate limit | a visitor suggests a docs URL (https only, public hosts only, never fetched automatically)                                          |
| `POST /internal/targets/sync`              | HMAC       | upsert the target files; a removed file disables its tool                                                                           |
| `POST /internal/cycles`                    | HMAC       | start a cycle, list the enabled tools; idempotent on `(ghRunId, ghRunAttempt)`                                                      |
| `POST /internal/compile`                   | HMAC       | plan-cache lookup, else the compiler (token budget, 2 model calls, 100 s)                                                           |
| `POST /internal/uploads`                   | HMAC       | signed Storage upload URLs for a run's logs                                                                                         |
| `POST /internal/runs`                      | HMAC       | ingest a `RunResult` (optionally with a `preflight` failure), classify it; idempotent on `(cycleId, toolSlug, attempt)`; 5 MB limit |
| `POST /internal/cycles/:id/finish`         | HMAC       | canary check, status engine, incidents, enrichment, web revalidation                                                                |
| `GET /admin/queue`                         | Bearer     | pending incidents and informational items                                                                                           |
| `POST /admin/incidents/:id/confirm`        | Bearer     | publish an incident (a human reviewed it)                                                                                           |
| `POST /admin/incidents/:id/false-positive` | Bearer     | resolve it and reset the streaks                                                                                                    |
| `POST /admin/tools/:slug/disable`          | Bearer     | disable a tool for good (a re-sync cannot re-enable it)                                                                             |
| `POST /admin/gc`                           | HMAC       | delete expired logs, false-positive diffs and traces; reports `freedBytes` (null when storage sizes are not visible)                |
| `GET /admin/stats?days=N`                  | Bearer     | cycles, harness errors, per-tool counts, UNKNOWNs, incidents, canaries, model tokens, storage used (calibration review, admin page) |
| `GET /admin/export/launch`                 | Bearer     | the numbers for the launch post; only incidents reviewed and CONFIRMED can appear                                                   |
| `POST /admin/plans/import`                 | Bearer     | a locally compiled plan with its extraction; the grounding validator runs again; stored under the plan cache key (8 MB limit)       |

HMAC: headers `X-QSR-Timestamp` (unix seconds) and `X-QSR-Signature: sha256=<hex>` over `timestamp + "." + rawBody`,
300 s window (`signRequest` / `verifyRequest` in `@qsr/core`, 100% covered). Errors are `application/problem+json`
without stack traces. Every log line carries a request id; `authorization` and signature headers are redacted.

## Running it

```
# the process Render runs
pnpm --filter api... build
DATABASE_URL=… INGEST_HMAC_SECRET=… ADMIN_TOKEN=… SUBMISSION_IP_SECRET=… node apps/api/dist/server.js
```

The environment is validated at start (`src/config.ts`); an error names the variable, never its value.

## Tests

```
docker compose -f docker-compose.test.yml up -d --wait
QSR_TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:54329/qsr_test pnpm --filter api test
docker compose -f docker-compose.test.yml down -v
```

The integration tests apply every migration to a throwaway Postgres (never Supabase). Without
`QSR_TEST_DATABASE_URL` they skip, unless `QSR_REQUIRE_DB=1` (set in CI), where a missing database fails the build.
`src/budget.ts` is held at 100% coverage.

## Calling it from code

```ts
import { createApiClient } from '@qsr/cli';

const api = createApiClient({
  baseUrl: process.env.API_BASE_URL!,
  secret: process.env.INGEST_HMAC_SECRET!,
});
await api.wakeApi(); // GET /health every 10 s for up to 3 minutes
const cycle = await api.post('/internal/cycles', { trigger: 'manual', gitSha: 'abcdef1' });
```
