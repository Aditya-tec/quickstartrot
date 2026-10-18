import { expect, test, type APIRequestContext } from '@playwright/test';
import { BLACKHOLE_URL } from './env';
import { FIXTURE_SLUGS, RUN_IDS } from './pages';

// The API is asleep or down: it accepts connections and never answers (e2e/blackhole.mjs). This web server is configured with that as its
// API address. Every public page, badge, share image and the status counts must still answer at once, and must not even try the API: they
// read the public database views, never the Render service. Only the /submit form needs the API, and opening it must not wait for it.

const count = async (request: APIRequestContext): Promise<number> =>
  ((await (await request.get(`${BLACKHOLE_URL}/__count`)).json()) as { attempts: number }).attempts;

const PUBLIC = [
  '/',
  '/?lang=python&sort=name&dir=asc',
  '/methodology',
  '/bot',
  '/incidents',
  '/submit',
  `/tools/${FIXTURE_SLUGS.healthy}`,
  `/tools/${FIXTURE_SLUGS.failing}`,
  `/runs/${RUN_IDS.healthy}`,
  `/api/badge/${FIXTURE_SLUGS.healthy}`,
  '/api/og/home',
  '/api/og/methodology',
  `/api/og/${FIXTURE_SLUGS.healthy}`,
  '/api/status',
  '/sitemap.xml',
  '/robots.txt',
];

test.describe('the API never answers', () => {
  test('every public page, badge, image and the status counts answer 200 within five seconds', async ({
    request,
  }) => {
    for (const path of PUBLIC) {
      const t0 = Date.now();
      const res = await request.get(path, { timeout: 5_000 });
      expect(res.status(), path).toBe(200);
      expect(Date.now() - t0, `${path} took too long`).toBeLessThan(5_000);
    }
  });

  test('and not one of them asked the API', async ({ request }) => {
    const before = await count(request);
    for (const path of PUBLIC.filter((p) => p !== '/submit'))
      await request.get(path, { timeout: 5_000 });
    expect(await count(request)).toBe(before);
  });

  test('the home page and a tool page are usable in a browser while the API is down', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.locator('#headline')).toBeVisible();
    await page.goto(`/tools/${FIXTURE_SLUGS.healthy}`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await page.goto('/methodology#detection');
    await expect(
      page.getByRole('heading', { name: /how well the monitor sees a broken quickstart/i }),
    ).toBeVisible();
  });

  test('opening /submit renders the form at once; the warm-up asks the API but nothing waits for it', async ({
    page,
    request,
  }) => {
    const before = await count(request);
    const t0 = Date.now();
    await page.goto('/submit');
    await expect(page.getByLabel('Docs URL of the quickstart')).toBeVisible();
    expect(Date.now() - t0, 'the form should not wait for the API').toBeLessThan(5_000);
    // the page's POST /api/warm answered at once; the wake-up request itself is held open by the black hole
    await expect.poll(() => count(request), { timeout: 10_000 }).toBeGreaterThan(before);
    const warm = await request.post('/api/warm', { timeout: 5_000 });
    expect(warm.status()).toBe(204);
  });
});
