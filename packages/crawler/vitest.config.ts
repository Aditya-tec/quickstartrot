import { defineConfig } from 'vitest/config';

// Every fixture test drives a real Chromium; see packages/cli/vitest.config.ts.
export default defineConfig({ test: { testTimeout: 30_000, hookTimeout: 60_000 } });
