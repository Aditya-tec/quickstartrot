import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      // P5: the classifier's decision logic is held at 100%: the rule table and how it is evaluated,
      // signatures, the RunResult adapter and the LLM fallback's acceptance checks.
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/types.ts', 'src/index.ts'],
      reporter: ['text'],
      thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 },
    },
  },
});
