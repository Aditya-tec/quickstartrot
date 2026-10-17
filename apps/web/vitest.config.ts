import { defineConfig } from 'vitest/config';
import path from 'node:path';

// Unit tests only (pure functions, data parsing, session signing). The browser tests are Playwright's.
export default defineConfig({
  // JSX in test files (the honesty test renders pages): the same automatic runtime Next uses
  oxc: { jsx: { runtime: 'automatic' } },
  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src') } },
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    environment: 'node',
    // the whole monorepo's tests run in parallel (turbo), so a CPU-starved worker can be slow: be generous
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
