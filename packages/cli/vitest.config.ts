import { defineConfig } from 'vitest/config';

// Several tests launch Chromium; under a parallel monorepo run (turbo) or a slow CI runner the
// default 5 s is too tight and produces flaky failures.
export default defineConfig({ test: { testTimeout: 30_000, hookTimeout: 60_000 } });
