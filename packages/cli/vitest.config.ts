import { defineConfig } from 'vitest/config';

// Several tests launch Chromium or Docker; under a parallel monorepo run (turbo) or a slow CI runner
// the default 5 s is too tight and produces flaky failures. Test files run one after another because
// the canary targets name a fixed fixture port (4177) that only one file may hold at a time.
export default defineConfig({
  test: { testTimeout: 30_000, hookTimeout: 60_000, fileParallelism: false },
});
