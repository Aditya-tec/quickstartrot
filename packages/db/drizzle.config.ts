import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './drizzle',
  dbCredentials: {
    // Session pooler / direct connection: drizzle-kit needs prepared statements and DDL.
    url: process.env['DIRECT_DATABASE_URL'] ?? '',
  },
});
