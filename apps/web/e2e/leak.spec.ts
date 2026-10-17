import { expect, test } from '@playwright/test';
import { FIXTURE_SLUGS, PAGES, RUN_IDS } from './pages';
import { UNREVIEWED_CAUSE } from '../src/lib/data/fixtures';

// THE SAFETY RULE. The fixtures hold a PENDING_REVIEW incident (tool fastify-node) with a distinctive cause string
// in its signature, its failing run, its log and its docs diff, and the fixture rows even claim the details are
// published. That string must appear nowhere a visitor can get it: not in the HTML of any page, not in the RSC
// payload the client receives, not in the badge, not in the sitemap, and not in a log the page links. The public
// status of that tool must be "verifying".

const NEEDLES = [UNREVIEWED_CAUSE, 'ZZ-UNREVIEWED-CAUSE', 'widget.render() was removed in 9.0'];
const expectClean = (what: string, text: string) => {
  for (const needle of NEEDLES)
    expect(text, `${what} must not contain "${needle}"`).not.toContain(needle);
};

test.describe('unreviewed incident: nothing leaks', () => {
  for (const p of PAGES) {
    test(`HTML of ${p.name}`, async ({ request }) => {
      const res = await request.get(p.path);
      expectClean(p.path, await res.text());
    });

    test(`RSC payload of ${p.name}`, async ({ request }) => {
      // what the browser receives on a client-side navigation
      const res = await request.get(p.path, { headers: { RSC: '1', 'Next-Url': p.path } });
      expectClean(`${p.path} (RSC)`, await res.text());
      const prefetch = await request.get(p.path, {
        headers: { RSC: '1', 'Next-Router-Prefetch': '1', 'Next-Url': p.path },
      });
      expectClean(`${p.path} (RSC prefetch)`, await prefetch.text());
    });
  }

  test('the DOM of the unreviewed tool page and its run page, after hydration', async ({
    page,
  }) => {
    for (const path of [
      `/tools/${FIXTURE_SLUGS.verifying}`,
      `/runs/${RUN_IDS.verifying}`,
      '/',
      '/incidents',
    ]) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      expectClean(`${path} (DOM)`, await page.content());
      expectClean(`${path} (text)`, await page.locator('body').innerText());
    }
  });

  test('every response the unreviewed tool page makes while loading is clean', async ({ page }) => {
    const bodies: string[] = [];
    page.on('response', async (r) => {
      const type = r.headers()['content-type'] ?? '';
      if (/json|text|javascript|x-component/.test(type))
        bodies.push(await r.text().catch(() => ''));
    });
    await page.goto(`/tools/${FIXTURE_SLUGS.verifying}`);
    await page.waitForLoadState('networkidle');
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) expectClean('a response of the tool page', body);
  });

  test('the badge, sitemap and robots', async ({ request }) => {
    for (const path of [`/api/badge/${FIXTURE_SLUGS.verifying}`, '/sitemap.xml', '/robots.txt']) {
      expectClean(path, await (await request.get(path)).text());
    }
  });

  test('the Open Graph image of the unreviewed tool renders (its inputs carry no cause)', async ({
    request,
  }) => {
    const res = await request.get(`/api/og/${FIXTURE_SLUGS.verifying}`);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toBe('image/png');
  });

  test('the public status of the unreviewed tool is "verifying" everywhere', async ({
    request,
    page,
  }) => {
    const badge = await (await request.get(`/api/badge/${FIXTURE_SLUGS.verifying}`)).text();
    expect(badge).toContain('quickstart: verifying');
    expect(badge).not.toContain('failing');
    await page.goto(`/tools/${FIXTURE_SLUGS.verifying}`);
    await expect(page.locator('[data-status]').first()).toHaveAttribute('data-status', 'verifying');
    await page.goto('/');
    const row = page.locator('[data-status="verifying"]:visible').first();
    await expect(row).toBeVisible();
  });

  test('the fixture artifact route refuses the log and the diff of the unreviewed tool', async ({
    request,
  }) => {
    for (const path of [
      'logs/fixture/fastify-fail-bbbbbbbbbbbbbbbbbbbbbbbb/01-s2.log.gz',
      'diffs/fixture/fastify-docs.diff',
    ])
      expect((await request.get(`/api/fixtures/${path}`)).status()).toBe(404);
  });

  test('no page uses dangerouslySetInnerHTML or injects markup from data (a log is plain text)', async ({
    page,
  }) => {
    await page.goto(`/tools/${FIXTURE_SLUGS.failing}`);
    await page
      .getByRole('button', { name: /Show log/ })
      .last()
      .click();
    await expect(page.getByTestId('log-lines')).toBeVisible();
    expect(await page.getByTestId('log-lines').locator('*:not(div):not(span)').count()).toBe(0);
  });
});
