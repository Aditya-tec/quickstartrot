# @qsr/db

Drizzle schema, migrations, typed client and seed script for the Supabase Postgres database (spec section 5). **Only `apps/api` writes to this database.**

## Public API

```ts
import { createDb, tools, runs, PUBLIC_VIEWS } from '@qsr/db';

const { db, close } = createDb(process.env.DATABASE_URL!); // transaction pooler, max 5, prepare: false
const rows = await db.select().from(tools);
await close();
```

- `schema.ts`: the 10 tables and 5 enums. Enum values come from `@qsr/core`, so the database and the Zod schemas cannot drift.
- `drizzle/0000_init.sql`: generated tables, indexes and the partial unique index `one_open_incident_per_tool`.
- `drizzle/0001_rls_and_public_views.sql`: RLS on every table with no policies, `anon` privileges revoked, and the three public views (`public_tools`, `public_runs`, `public_incidents`) granted to `anon`.

## Commands

| Command            | What it does                                                            |
| ------------------ | ----------------------------------------------------------------------- |
| `pnpm db:generate` | Generate a migration from `schema.ts` (needs `DIRECT_DATABASE_URL`)     |
| `pnpm db:migrate`  | Apply migrations over `DIRECT_DATABASE_URL` (session pooler)            |
| `pnpm db:seed`     | Insert 3 fake `seed-*` tools with runs and incidents (re-runnable)      |
| `pnpm test:rls`    | P1 acceptance test: anon reads the views, gets nothing from base tables |

`pnpm test` skips the RLS test when Supabase env vars are absent (CI). `test:rls` loads `../../.env`.

## Public status mapping

An internal `BROKEN` tool shows as `DEGRADED` in `public_tools` unless its open incident is `CONFIRMED`.
Runs from invalid or unfinished cycles never appear in `public_runs` or in the pass rate.
