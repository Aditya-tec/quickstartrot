import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The golden tests drive a real Chromium; see packages/cli/vitest.config.ts.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
      // Spec section 14: 100% on compiler/grounding. Enforced whenever tests run with --coverage.
      include: ['src/grounding/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/*.test-utils.ts'],
      reporter: ['text'],
      thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 },
    },
  },
});
