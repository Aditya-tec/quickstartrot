import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      // P5 (spec section 4: "status package is pure functions with 100% coverage").
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/index.ts'],
      reporter: ['text'],
      thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 },
    },
  },
});
