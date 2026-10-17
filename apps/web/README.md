# @qsr/web

The public website (Next.js 15 App Router, Tailwind 4, shadcn-style components, Geist fonts bundled locally) on Vercel.
It reads only the four public views of Supabase (`public_tools`, `public_run_history`, `public_runs`, `public_incidents`) with the
PUBLIC anon key, on the server, and parses every row with the Zod schemas from `@qsr/core`. Deploying: `DEPLOY.md`, section
"Deploying the website (Vercel)".

## Routes

| Route                                 | What it is                                                                                          |
| ------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `/`                                   | "X of Y quickstarts work", a level-aware breakdown, filters and sort in the URL, "Needs a person"   |
| `/tools/[slug]`                       | status, last 60 runs, the confirmed incident (reviewed text, docs diff, version diff), latest steps |
| `/runs/[id]`                          | plan, grounding report, truncation record, every step, environment                                  |
| `/incidents`, `/methodology`, `/bot`  | confirmed incidents; how it works and its limits; the crawler and how to opt out                    |
| `/submit`                             | the submit form (`POST /api/submit` forwards to the API with retries while it wakes)                |
| `/admin`, `/admin/login`              | the review queue; token login, signed httpOnly cookie, middleware, server actions                   |
| `/api/badge/[slug]`, `/api/og/[slug]` | the README badge (SVG) and the social images (`/api/og/home` for the home page)                     |
| `/api/revalidate`                     | `POST` with `x-revalidate-secret`: the API calls it when a cycle finishes                           |
| `/api/fixtures/*`                     | test only: serves fixture logs and diffs when `QSR_DATA=fixtures`; 404 otherwise                    |

## The rule that matters most

A failure that no person has reviewed shows **"verifying"** and **no cause**: not in the HTML, the RSC payload, the badge, the
image or any JSON. Three layers enforce it: the database views mask the details (migration 0006), the loaders in
`src/lib/service.ts` only ever return view models built from confirmed incidents and sanitised runs (`confirmedOnly`,
`sanitizeRun` in `@qsr/core/public`), and one function, `publicStatus`, decides the status everywhere. The fixtures contain
deliberately poisoned rows; `e2e/leak.spec.ts` and `src/lib/service.test.ts` prove none of it reaches a visitor.

## Public API (the modules other code uses)

```ts
import { getDataSource } from '@/lib/data'; // SupabaseDataSource, or FixtureDataSource when QSR_DATA=fixtures
import { loadHome, loadToolPage, loadRunPage } from '@/lib/service'; // view models; no raw rows, no unconfirmed incident
import { renderBadge, badgeFor } from '@/lib/badge'; // XML-escaped SVG, no external reference
```

Pages never import `@supabase/supabase-js`; only `src/lib/data/supabase.ts` does. No file uses `dangerouslySetInnerHTML` (a lint rule and a test).

## Running it

```
QSR_DATA=fixtures pnpm --filter @qsr/web dev          # seeded data, no credentials, http://localhost:3100
pnpm --filter @qsr/web build                           # production build
pnpm --filter @qsr/web test                            # unit tests (vitest)
pnpm --filter @qsr/web test:e2e                        # Playwright + axe against the production build, fixtures, stub API
pnpm --filter @qsr/web lighthouse                      # Lighthouse on / and a tool page (production build)
node --env-file=../../.env node_modules/vitest/vitest.mjs run src/lib/data/supabase.contract.test.ts   # live views (needs the anon key)
```

Environment variables (names only): `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
`API_BASE_URL`, `ADMIN_TOKEN`, `ADMIN_SESSION_SECRET`, `REVALIDATE_SECRET`, optional `NEXT_PUBLIC_CONTACT_EMAIL` and
`NEXT_PUBLIC_TURNSTILE_SITE_KEY`; test only: `QSR_DATA=fixtures`, `QSR_FIXTURE_OVERRIDE`.

## Caching

Next 15 does not cache `fetch` by default, so every loader is wrapped in `unstable_cache` (tag `qsr-data`, 5 minutes) in
`src/lib/cached.ts`. `POST /api/revalidate` (and confirming an incident in `/admin`) invalidates the tag. `e2e/revalidate.spec.ts`
proves a page keeps its cached state until the endpoint is called with the secret.

## Local files that are not committed

`screenshots/` (`pnpm exec playwright test --project=screenshots`), `lighthouse-reports/`, `test-results/`, `e2e/.tmp/`.

## Deploying

`vercel.json` has an ignored build step: Vercel skips a commit whose diff does not touch `apps/web`, `packages/core`, the lockfile or the
workspace files ("The deployment was canceled because the Ignored Build Step command returned exit code 0"). That is intended, but it
also skips the very first deploy when the newest commit only changed docs. If that happens, push any change under `apps/web`, or run
`vercel --prod` from the repository root. `DEPLOY.md` has the full checklist.
