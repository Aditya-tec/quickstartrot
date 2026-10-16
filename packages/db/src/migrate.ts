import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { fileURLToPath } from 'node:url';

// Applies ./drizzle migrations over DIRECT_DATABASE_URL (session pooler: DDL needs a real session).
const url = process.env['DIRECT_DATABASE_URL'];
if (!url) throw new Error('DIRECT_DATABASE_URL is not set');

const client = postgres(url, { max: 1, prepare: false, onnotice: () => undefined });
try {
  await migrate(drizzle(client), {
    migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)),
  });
  console.log(JSON.stringify({ msg: 'migrations applied' }));
} finally {
  await client.end({ timeout: 5 });
}
