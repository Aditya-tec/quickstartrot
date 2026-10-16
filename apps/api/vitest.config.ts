import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./test/global-setup.ts'],
    // The integration tests share one Postgres: files run one after the other.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
      // P6: 100% on the token-budget guard (the HMAC verifier is held at 100% in @qsr/core).
      include: ['src/budget.ts'],
      reporter: ['text'],
      thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 },
    },
  },
});
