import { expect, test } from '@playwright/test';
import { PublicStatusSummary } from '@qsr/core/public';

// The counts the README is generated from.

test.describe('GET /api/status', () => {
  test('is the strict public summary, cached like the pages, and the same numbers as the home page', async ({
    request,
    page,
  }) => {
    const res = await request.get('/api/status');
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toMatch(/application\/json/);
    expect(res.headers()['cache-control']).toMatch(/s-maxage=300/);
    const summary = PublicStatusSummary.parse(await res.json());
    await page.goto('/');
    const headline = await page.locator('#headline').innerText();
    expect(headline.replaceAll(/\s+/g, ' ')).toContain(
      `${summary.headline.passing} of ${summary.headline.tested}`,
    );
  });
});
