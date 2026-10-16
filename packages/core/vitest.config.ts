import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      // 100% on path normalization (P4), the HMAC verifier and the canary check (P6). Enforced whenever tests run with --coverage.
      include: ['src/work-path.ts', 'src/hmac.ts', 'src/canary.ts', 'src/canonical.ts'],
      reporter: ['text'],
      thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 },
    },
  },
});
