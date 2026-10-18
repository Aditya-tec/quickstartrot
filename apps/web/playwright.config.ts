import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import {
  ADMIN_SESSION_SECRET,
  ADMIN_TOKEN,
  REVALIDATE_SECRET,
  STUB_PORT,
  STUB_URL,
  WEB_PORT,
  WEB_PORT_REVALIDATE,
} from './e2e/env';

// End-to-end tests run against the PRODUCTION build (run `pnpm build` first) with QSR_DATA=fixtures and a stub
// API in place of Render. Two servers: the main one, and a second one with a writable fixture override file
// that only the revalidation test uses (it changes the data while the server runs).

const OVERRIDE_FILE = path.join(import.meta.dirname, 'e2e', '.tmp', 'override.json');

const webEnv = {
  QSR_DATA: 'fixtures',
  NEXT_PUBLIC_SITE_URL: `http://localhost:${WEB_PORT}`,
  API_BASE_URL: STUB_URL,
  ADMIN_TOKEN,
  ADMIN_SESSION_SECRET,
  REVALIDATE_SECRET,
  NEXT_TELEMETRY_DISABLED: '1',
  QSR_WARM_WINDOW_MS: '0',
};

export default defineConfig({
  testDir: 'e2e',
  testMatch: /.*\.spec\.ts/,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env['CI']),
  retries: process.env['CI'] ? 1 : 0,
  reporter: [['list']],
  use: { baseURL: `http://localhost:${WEB_PORT}`, trace: 'retain-on-failure' },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
      testIgnore: /(revalidate|screenshots)\.spec/,
    },
    {
      name: 'mobile',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 375, height: 812 },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
      },
      testIgnore: /(revalidate|screenshots)\.spec/,
    },
    {
      name: 'revalidate',
      use: { ...devices['Desktop Chrome'], baseURL: `http://localhost:${WEB_PORT_REVALIDATE}` },
      testMatch: /revalidate\.spec/,
    },
    { name: 'screenshots', use: { ...devices['Desktop Chrome'] }, testMatch: /screenshots\.spec/ },
  ],
  webServer: [
    {
      command: 'node e2e/stub-api.mjs',
      port: STUB_PORT,
      env: { STUB_API_PORT: String(STUB_PORT), ADMIN_TOKEN },
      reuseExistingServer: !process.env['CI'],
    },
    {
      command: `npx next start --port ${WEB_PORT}`,
      port: WEB_PORT,
      env: webEnv,
      reuseExistingServer: !process.env['CI'],
      timeout: 120_000,
    },
    {
      command: `npx next start --port ${WEB_PORT_REVALIDATE}`,
      port: WEB_PORT_REVALIDATE,
      env: {
        ...webEnv,
        NEXT_PUBLIC_SITE_URL: `http://localhost:${WEB_PORT_REVALIDATE}`,
        QSR_FIXTURE_OVERRIDE: OVERRIDE_FILE,
      },
      reuseExistingServer: !process.env['CI'],
      timeout: 120_000,
    },
  ],
});
