import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { ADMIN_TOKEN } from './env';
import { FIXTURE_SLUGS, PAGES } from './pages';

// axe-core on every page, in both themes, at desktop and 375 px width (the two Playwright projects). The bar is
// zero violations of any impact.

const THEMES = ['light', 'dark'] as const;

async function violations(page: Page) {
  const result = await new AxeBuilder({ page }).analyze();
  return result.violations.map((v) => ({
    rule: v.id,
    impact: v.impact,
    help: v.help,
    targets: v.nodes
      .slice(0, 4)
      .map((n) => `${n.target.join(' ')} :: ${n.failureSummary?.split('\n')[1] ?? ''}`),
  }));
}

for (const theme of THEMES) {
  test.describe(`axe, ${theme} theme`, () => {
    test.beforeEach(async ({ page }) => {
      if (theme === 'dark')
        await page.addInitScript(() => localStorage.setItem('qsr-theme', 'dark'));
    });

    for (const p of PAGES) {
      test(p.name, async ({ page }) => {
        await page.goto(p.path);
        await page.waitForLoadState('networkidle');
        expect(await violations(page)).toEqual([]);
      });
    }

    test('tool page with the log expanded', async ({ page }) => {
      await page.goto(`/tools/${FIXTURE_SLUGS.failing}`);
      await page
        .getByRole('button', { name: /Show log/ })
        .last()
        .click();
      await expect(page.getByTestId('log-lines')).toBeVisible();
      expect(await violations(page)).toEqual([]);
    });

    test('submit page showing an error', async ({ page }) => {
      await page.goto('/submit');
      await page.getByLabel('Docs URL of the quickstart').fill('http://nope');
      await page.getByRole('button', { name: 'Submit quickstart' }).click();
      await expect(page.getByTestId('submit-error')).toBeVisible();
      expect(await violations(page)).toEqual([]);
    });

    test('admin queue', async ({ page }) => {
      await page.context().setExtraHTTPHeaders({
        'x-forwarded-for': `10.9.${theme === 'dark' ? 1 : 2}.${Math.floor(Math.random() * 250)}`,
      });
      await page.goto('/admin/login');
      await page.getByLabel('Admin token').fill(ADMIN_TOKEN);
      await page.getByRole('button', { name: 'Sign in' }).click();
      await expect(page.getByRole('heading', { name: 'Admin queue' })).toBeVisible();
      expect(await violations(page)).toEqual([]);
    });
  });
}
