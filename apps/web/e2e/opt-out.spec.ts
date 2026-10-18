import { expect, test } from '@playwright/test';
import { FixtureDataSource } from '../src/lib/data/fixtures';
import { FIXTURE_SLUGS } from './pages';

// A vendor opted out (owner decision 2026-10-19): probing stops, the page stays up labelled "no longer monitored at the vendor's request",
// past results stay visible, and they are hidden only when the vendor asks. leak.spec.ts holds the hidden tool's rows to the zero-leak rule.

const LABEL = "No longer monitored at the vendor's request";
const source = new FixtureDataSource();

test.describe('a vendor that opted out, history visible', () => {
  test('the page is labelled, says when probing stopped, and still shows the past results', async ({
    page,
  }) => {
    await page.goto(`/tools/${FIXTURE_SLUGS.optedOut}`);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Sunset SDK');
    await expect(page.locator('[data-status="opted_out"]').first()).toContainText(LABEL);
    await expect(page.getByText(/Probing stopped on Oct \d+/)).toBeVisible();
    await expect(
      page.getByText('The results below are from before probing stopped.'),
    ).toBeVisible();
    await expect(page.getByRole('list', { name: /\d+ recent runs?/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Latest run' })).toBeVisible();
    // no live status, no badge snippets for a tool nobody monitors
    await expect(page.locator('[data-status="passing"]')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Markdown' })).toHaveCount(0);
  });

  test('a run of it is still a page', async ({ page }) => {
    const id = (await source.listTools()).find((t) => t.slug === FIXTURE_SLUGS.optedOut)
      ?.last_run_id as string;
    const res = await page.goto(`/runs/${id}`);
    expect(res?.status()).toBe(200);
  });
});

test.describe('a vendor that opted out and asked for its past results to be hidden', () => {
  test('the page is labelled and shows no result of any kind', async ({ page }) => {
    await page.goto(`/tools/${FIXTURE_SLUGS.historyHidden}`);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Hidden History SDK');
    await expect(page.locator('[data-status="opted_out"]').first()).toContainText(LABEL);
    await expect(
      page.getByText("At the vendor's request, the past results are not shown."),
    ).toBeVisible();
    await expect(page.getByRole('list', { name: /\d+ recent runs?/ })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Latest run' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Earlier incidents' })).toHaveCount(0);
    await expect(page.getByText('30-day pass rate')).toHaveCount(0);
  });

  test('its runs are not pages, though the data layer below still holds them', async ({ page }) => {
    const [h] = await source.listToolHistory(FIXTURE_SLUGS.historyHidden, 1);
    const res = await page.goto(`/runs/${(h as { run_id: string }).run_id}`);
    expect(res?.status()).toBe(404);
  });

  test('its incident is not on the incidents page', async ({ page }) => {
    await page.goto('/incidents');
    await expect(page.getByText('Hidden History SDK')).toHaveCount(0);
  });
});

test.describe('on the home page and in the badge', () => {
  test('both are listed apart, under the label, and are not in the tables or the headline', async ({
    page,
  }) => {
    await page.goto('/');
    const section = page.getByRole('region', { name: LABEL });
    await expect(section.getByRole('link', { name: 'Sunset SDK' })).toBeVisible();
    await expect(section.getByRole('link', { name: 'Hidden History SDK' })).toBeVisible();
    const tables = page.locator('#leaderboard').locator('..');
    await expect(tables.getByText('Sunset SDK')).toHaveCount(0);
    await expect(tables.getByText('Hidden History SDK')).toHaveCount(0);
  });

  test('the badge of each says it is no longer monitored', async ({ request }) => {
    for (const slug of [FIXTURE_SLUGS.optedOut, FIXTURE_SLUGS.historyHidden]) {
      const svg = await (await request.get(`/api/badge/${slug}`)).text();
      expect(svg).toContain('quickstart: no longer monitored');
    }
  });

  test('the social image of each renders', async ({ request }) => {
    for (const slug of [FIXTURE_SLUGS.optedOut, FIXTURE_SLUGS.historyHidden]) {
      const res = await request.get(`/api/og/${slug}`);
      expect(res.status()).toBe(200);
      expect(res.headers()['content-type']).toBe('image/png');
    }
  });
});
