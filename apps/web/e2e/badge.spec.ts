import { expect, test } from '@playwright/test';
import { FIXTURE_SLUGS } from './pages';

const CASES: [string, string][] = [
  [FIXTURE_SLUGS.healthy, 'passing'],
  [FIXTURE_SLUGS.failing, 'failing'],
  [FIXTURE_SLUGS.verifying, 'verifying'],
  [FIXTURE_SLUGS.unknown, 'unknown'],
  [FIXTURE_SLUGS.needsPerson, 'needs a person'],
  ['no-such-tool', 'not tracked'],
];

test.describe('badge', () => {
  for (const [slug, value] of CASES) {
    test(`${slug} shows "${value}"`, async ({ request }) => {
      const res = await request.get(`/api/badge/${slug}`);
      expect(res.status()).toBe(200);
      expect(res.headers()['content-type']).toContain('image/svg+xml');
      expect(res.headers()['cache-control']).toBe(
        'public, s-maxage=600, stale-while-revalidate=86400',
      );
      const svg = await res.text();
      expect(svg).toContain(`aria-label="quickstart: ${value}"`);
    });
  }

  test('is self-contained: no script, no link, no external request', async ({ request }) => {
    const svg = await (await request.get(`/api/badge/${FIXTURE_SLUGS.failing}`)).text();
    expect(svg).not.toMatch(
      /<script|<a[ >]|href=|xlink|<image|<foreignObject|<style|url\(|https?:\/\/(?!www\.w3\.org)/i,
    );
  });

  test('carries a locked-down CSP and nosniff', async ({ request }) => {
    const res = await request.get(`/api/badge/${FIXTURE_SLUGS.healthy}`);
    expect(res.headers()['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers()['x-content-type-options']).toBe('nosniff');
  });

  test('renders in a browser as an image', async ({ page }) => {
    await page.goto(`/api/badge/${FIXTURE_SLUGS.healthy}`);
    await expect(page.locator('svg')).toBeVisible();
  });

  const PAYLOADS = [
    '"><script>alert(1)</script>',
    '<svg onload=alert(1)>',
    "a'b",
    '../../etc/passwd',
    '%3Cscript%3Ealert(1)%3C/script%3E',
    'UPPER',
    'a'.repeat(200),
    'a--b',
    '-a',
  ];
  for (const payload of PAYLOADS) {
    test(`a hostile slug is "not tracked" and never reflected: ${payload.slice(0, 30)}`, async ({
      request,
    }) => {
      const res = await request.get(`/api/badge/${encodeURIComponent(payload)}`);
      expect([200, 404]).toContain(res.status());
      if (res.status() === 200) {
        const svg = await res.text();
        expect(svg).toContain('not tracked');
        expect(svg).not.toContain('alert(1)');
        expect(svg).not.toContain('onload');
        expect(svg).not.toContain('passwd');
      }
    });
  }
});
