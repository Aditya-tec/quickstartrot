import { expect, test } from '@playwright/test';
import { FIXTURE_SLUGS } from './pages';

test.describe('home', () => {
  test('headline says X of Y, with an as-of time, and counts only tested tools', async ({
    page,
  }) => {
    await page.goto('/');
    const h1 = page.getByRole('heading', { level: 1 });
    await expect(h1).toContainText(/\d+ of \d+/);
    await expect(h1).toContainText('quickstarts pass their checks today');
    await expect(page.getByText(/As of Oct 17/)).toBeVisible();
    // the manual-stop tool is not part of X or Y
    const text = await h1.innerText();
    const counts = (/(\d+) of (\d+)/.exec(text) ?? []).slice(1).map(Number);
    const x = counts[0] ?? NaN;
    const y = counts[1] ?? NaN;
    const rows = await page.locator('table tbody tr, ul.md\\:hidden > li').count();
    expect(y).toBeGreaterThan(0);
    expect(x).toBeLessThanOrEqual(y);
    expect(rows).toBeGreaterThanOrEqual(y);
  });

  test('is honest about how far tools were tested: L3 and L2 are counted separately', async ({
    page,
  }) => {
    await page.goto('/');
    const box = page
      .getByRole('heading', { name: 'How far each quickstart was tested' })
      .locator('..');
    await expect(box).toContainText('L3');
    await expect(box).toContainText('L2');
    await expect(box).toContainText(/reached the vendor/i);
    await expect(box).toContainText(/not run against the vendor/i);
  });

  test('lists manual-stop tools in "Needs a person", outside the headline', async ({ page }) => {
    await page.goto('/');
    const group = page.getByRole('region', { name: 'Needs a person' });
    await expect(group).toContainText(/hono/i);
    await expect(group).toContainText(/not counted/i);
    await expect(page.locator('table')).not.toContainText(FIXTURE_SLUGS.needsPerson);
  });

  test('puts broken tools first by default', async ({ page, isMobile }) => {
    await page.goto('/');
    const first = isMobile
      ? page.locator('ul.md\\:hidden > li').first()
      : page.locator('table tbody tr').first();
    await expect(first).toContainText(/Failing/);
  });

  test('filters and sort live in the URL and are rendered by the server', async ({
    page,
    isMobile,
  }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'Python', exact: true }).click();
    await expect(page).toHaveURL(/lang=python/);
    const names = isMobile
      ? page.locator('ul.md\\:hidden > li a[href^="/tools/"]')
      : page.locator('table tbody th a[href^="/tools/"]');
    const count = await names.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i += 1)
      await expect(names.nth(i)).toHaveAttribute('href', /-python$/);

    // a shared link renders the same view without JavaScript state
    const direct = await page.request.get('/?lang=python&status=passing');
    const html = await direct.text();
    expect(html).toContain('dotenv-python');
    expect(html).not.toContain('chalk-node');
  });

  test('sorts by name and flips direction when the same sort is chosen again', async ({ page }) => {
    await page.goto('/?sort=name&dir=asc');
    const names = async () =>
      page
        .locator('table tbody th a[href^="/tools/"], ul.md\\:hidden > li a[href^="/tools/"]')
        .evaluateAll((els) =>
          els
            .filter((e) => (e as HTMLElement).offsetParent !== null)
            .map((e) => e.textContent ?? ''),
        );
    const asc = (await names()).filter((n) => n !== '');
    await page.getByRole('link', { name: /^Name/ }).click();
    await expect(page).toHaveURL(/dir=desc/);
    const desc = (await names()).filter((n) => n !== '');
    expect(desc[0]).toBe(asc[asc.length - 1]);
  });

  test('shows an empty state when no tool matches', async ({ page }) => {
    await page.goto('/?lang=python&status=failing');
    await expect(page.getByText('No quickstarts match these filters.')).toBeVisible();
    await page.getByRole('link', { name: 'Clear the filters' }).click();
    await expect(page).toHaveURL(/\/$/);
  });

  test('each status is an icon and a word, never colour alone', async ({ page }) => {
    await page.goto('/');
    const pills = page.locator('[data-status]');
    const n = await pills.count();
    expect(n).toBeGreaterThan(3);
    for (let i = 0; i < n; i += 1) {
      await expect(pills.nth(i).locator('svg')).toHaveCount(1);
      expect((await pills.nth(i).innerText()).trim().length).toBeGreaterThan(2);
    }
  });

  test('uses cards at 375 px and a table on desktop', async ({ page, isMobile }) => {
    await page.goto('/');
    if (isMobile) {
      await expect(page.locator('table')).toBeHidden();
      await expect(page.locator('ul.md\\:hidden').first()).toBeVisible();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
    } else {
      await expect(page.locator('table')).toBeVisible();
    }
  });

  test('the dot strip has an accessible summary', async ({ page }) => {
    await page.goto('/');
    await expect(
      page.getByRole('img', { name: /\d+ recent runs?: \d+ passed/ }).first(),
    ).toBeAttached();
  });
});
