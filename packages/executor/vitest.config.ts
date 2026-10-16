import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
      // P4: 100% on auth-error evaluation. (Path normalization, the other 100% item, lives in
      // @qsr/core and is gated there.) Enforced whenever tests run with --coverage.
      include: ['src/expect.ts'],
      reporter: ['text'],
      thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 },
    },
  },
});
