import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { test } from '@playwright/test';
import { ADMIN_TOKEN } from './env';
import { FIXTURE_SLUGS, PAGES } from './pages';

// Full-page screenshots of every page at 375 and 1280 px, light and dark, for visual review. They are written to
// apps/web/screenshots/<theme>-<width>/<page>.png (git-ignored). Not assertions: a person opens them.

const OUT = path.join(import.meta.dirname, '..', 'screenshots');
const VIEWPORTS = [
  { width: 375, height: 812 },
  { width: 1280, height: 800 },
] as const;

for (const theme of ['light', 'dark'] as const) {
  for (const viewport of VIEWPORTS) {
    test.describe(`${theme} ${viewport.width}`, () => {
      test.use({ colorScheme: theme, viewport, deviceScaleFactor: 1 });
      const dir = path.join(OUT, `${theme}-${viewport.width}`);
      test.beforeAll(() => mkdirSync(dir, { recursive: true }));

      for (const p of PAGES) {
        test(p.name, async ({ page }) => {
          await page.goto(p.path);
          await page.waitForLoadState('networkidle');
          await page.screenshot({ path: path.join(dir, `${p.name}.png`), fullPage: true });
        });
      }

      test('tool-failing-log-open', async ({ page }) => {
        await page.goto(`/tools/${FIXTURE_SLUGS.failing}`);
        await page
          .getByRole('button', { name: /Show log/ })
          .last()
          .click();
        await page.getByTestId('log-lines').waitFor();
        await page.screenshot({
          path: path.join(dir, 'tool-failing-log-open.png'),
          fullPage: true,
        });
      });

      test('submit-waking', async ({ page }) => {
        await page.goto('/submit');
        await page
          .getByLabel('Docs URL of the quickstart')
          .fill('https://docs.example.com/slow-quickstart');
        await page.getByRole('button', { name: 'Submit quickstart' }).click();
        await page.getByTestId('waking').waitFor();
        await page.screenshot({ path: path.join(dir, 'submit-waking.png'), fullPage: true });
      });

      test('admin-queue', async ({ page }) => {
        await page.context().setExtraHTTPHeaders({
          'x-forwarded-for': `10.7.${theme === 'dark' ? 1 : 2}.${viewport.width % 250}`,
        });
        await page.goto('/admin/login');
        await page.getByLabel('Admin token').fill(ADMIN_TOKEN);
        await page.getByRole('button', { name: 'Sign in' }).click();
        await page.getByRole('heading', { name: 'Admin queue' }).waitFor();
        await page.screenshot({ path: path.join(dir, 'admin-queue.png'), fullPage: true });
      });
    });
  }
}
