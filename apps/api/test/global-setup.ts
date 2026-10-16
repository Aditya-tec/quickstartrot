import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import type { GlobalSetupContext } from 'vitest/node';

// The API integration tests run against a throwaway Postgres (docker-compose.test.yml), never Supabase.
// Setup rebuilds the public schema from ALL migrations, so a schema change that breaks a migration fails here.
//
//   docker compose -f docker-compose.test.yml up -d --wait
//   QSR_TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:54329/qsr_test pnpm --filter @qsr/api test
//
// Without QSR_TEST_DATABASE_URL (or with the database down) the database tests skip, unless QSR_REQUIRE_DB=1
// (set in CI), where a missing database is a failure and not a silent skip.

declare module 'vitest' {
  export interface ProvidedContext {
    testDatabaseUrl: string | null;
  }
}

const MIGRATIONS = fileURLToPath(new URL('../../../packages/db/drizzle', import.meta.url));

export default async function setup({ provide }: GlobalSetupContext): Promise<void> {
  const url = process.env['QSR_TEST_DATABASE_URL'];
  const required = process.env['QSR_REQUIRE_DB'] === '1';
  if (!url) {
    if (required) throw new Error('QSR_REQUIRE_DB=1 but QSR_TEST_DATABASE_URL is not set');
    provide('testDatabaseUrl', null);
    return;
  }
  const sql = postgres(url, {
    max: 1,
    prepare: false,
    onnotice: () => undefined,
    connect_timeout: 5,
  });
  try {
    await sql`select 1`;
  } catch (error) {
    await sql.end({ timeout: 1 }).catch(() => undefined);
    if (required)
      throw new Error(`QSR_REQUIRE_DB=1 but the test database is unreachable: ${String(error)}`);
    provide('testDatabaseUrl', null);
    return;
  }
  try {
    // The Supabase roles already exist (docker/test-db/init.sql); the public schema is rebuilt.
    await sql.unsafe('DROP SCHEMA IF EXISTS drizzle CASCADE');
    await sql.unsafe('DROP SCHEMA public CASCADE');
    await sql.unsafe('CREATE SCHEMA public');
    await sql.unsafe('GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role');
    await sql.unsafe(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role',
    );
    await sql.unsafe(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role',
    );
    await migrate(drizzle(sql), { migrationsFolder: path.resolve(MIGRATIONS) });
  } finally {
    await sql.end({ timeout: 5 });
  }
  provide('testDatabaseUrl', url);
}
