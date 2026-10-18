import { expect, test } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';
import { STUB_URL } from './env';

test.beforeEach(async ({ request }) => {
  await request.post(`${STUB_URL}/__reset`);
});

async function fill(page: Page, url: string, extra: { contact?: string } = {}) {
  await page.goto('/submit');
  await page.getByLabel('Docs URL of the quickstart').fill(url);
  if (extra.contact) await page.getByLabel('Your contact (optional)').fill(extra.contact);
}

test.describe('submit', () => {
  test('happy path: the API receives the validated submission', async ({ page, request }) => {
    await fill(page, 'https://docs.example.com/quickstart', { contact: 'me@example.com' });
    await page.getByRole('button', { name: 'Submit quickstart' }).click();
    await expect(page.getByTestId('submit-done')).toContainText('received');
    const state = await (await request.get(`${STUB_URL}/__state`)).json();
    expect(state.submissions).toHaveLength(1);
    expect(state.submissions[0]).toMatchObject({
      docsUrl: 'https://docs.example.com/quickstart',
      contact: 'me@example.com',
    });
    // the API sees a visitor address to rate limit by, and the form sent no honeypot or credentials
    expect(Object.keys(state.submissions[0])).not.toContain('company');
  });

  test('cold start: says the server is waking up, then succeeds', async ({ page, request }) => {
    await fill(page, 'https://docs.example.com/slow-quickstart');
    await page.getByRole('button', { name: 'Submit quickstart' }).click();
    await expect(page.getByTestId('waking')).toContainText(
      'Waking the server, this can take up to a minute',
    );
    await expect(page.getByTestId('submit-done')).toBeVisible({ timeout: 30_000 });
    expect((await (await request.get(`${STUB_URL}/__state`)).json()).submissions).toHaveLength(1);
  });

  test('retries while the API answers 503 (it is still starting)', async ({ page, request }) => {
    await fill(page, 'https://docs.example.com/wakeup');
    await page.getByRole('button', { name: 'Submit quickstart' }).click();
    await expect(page.getByTestId('submit-done')).toBeVisible({ timeout: 30_000 });
    const state = await (await request.get(`${STUB_URL}/__state`)).json();
    expect(state.wakeAttempts).toBe(3);
  });

  test('rejects a bad URL with a reason and never calls the API', async ({ page, request }) => {
    await fill(page, 'http://127.0.0.1/quickstart');
    await page.getByRole('button', { name: 'Submit quickstart' }).click();
    await expect(page.getByTestId('submit-error')).toContainText(/https/);
    const state = await (await request.get(`${STUB_URL}/__state`)).json();
    expect(state.submissions).toHaveLength(0);
    expect(state.forwardedFor).toHaveLength(0);
  });

  test('shows the daily limit', async ({ page }) => {
    await fill(page, 'https://docs.example.com/rate-limit');
    await page.getByRole('button', { name: 'Submit quickstart' }).click();
    await expect(page.getByTestId('submit-error')).toContainText(/limit of submissions/);
  });

  test('shows a failed human check', async ({ page }) => {
    await fill(page, 'https://docs.example.com/turnstile');
    await page.getByRole('button', { name: 'Submit quickstart' }).click();
    await expect(page.getByTestId('submit-error')).toContainText(/human check failed/);
  });

  test('shows a network failure', async ({ page }) => {
    await fill(page, 'https://docs.example.com/quickstart');
    await page.route('**/api/submit', (route) => route.abort('failed'));
    await page.getByRole('button', { name: 'Submit quickstart' }).click();
    await expect(page.getByTestId('submit-error')).toContainText(/connection failed/);
  });

  test('a filled honeypot looks like success but stores nothing', async ({ page, request }) => {
    await fill(page, 'https://docs.example.com/quickstart');
    await page.evaluate(() => {
      (document.getElementById('company') as HTMLInputElement).value = 'Acme Bots';
    });
    await page.getByRole('button', { name: 'Submit quickstart' }).click();
    await expect(page.getByTestId('submit-done')).toBeVisible();
    expect((await (await request.get(`${STUB_URL}/__state`)).json()).submissions).toHaveLength(0);
  });

  test('the honeypot is not reachable by keyboard or screen reader', async ({ page }) => {
    await page.goto('/submit');
    await expect(page.locator('#company')).toHaveAttribute('tabindex', '-1');
    expect(
      await page.locator('#company').evaluate((el) => el.closest('[aria-hidden="true"]') !== null),
    ).toBe(true);
  });

  test('the browser never learns the API address', async ({ page }) => {
    const seen: string[] = [];
    page.on('request', (r) => seen.push(r.url()));
    await fill(page, 'https://docs.example.com/quickstart');
    await page.getByRole('button', { name: 'Submit quickstart' }).click();
    await expect(page.getByTestId('submit-done')).toBeVisible();
    expect(seen.filter((u) => u.includes('4010'))).toEqual([]);
    expect(await page.content()).not.toContain('4010');
  });

  test('POST /api/submit refuses a huge or unreadable body', async ({ request }) => {
    const big = await request.post('/api/submit', {
      data: { docsUrl: 'https://a.example.com/' + 'x'.repeat(20_000) },
    });
    expect(big.status()).toBe(413);
    const bad = await request.post('/api/submit', {
      data: 'not json',
      headers: { 'content-type': 'text/plain' },
    });
    expect(bad.status()).toBe(400);
  });
});

test.describe('waking the API', () => {
  const healthChecks = async (request: APIRequestContext) =>
    ((await (await request.get(`${STUB_URL}/__state`)).json()) as { healthChecks: number })
      .healthChecks;

  test('opening /submit wakes the API once, before any form is sent', async ({ page, request }) => {
    await page.goto('/submit');
    await expect.poll(() => healthChecks(request), { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
    expect((await (await request.get(`${STUB_URL}/__state`)).json()).submissions).toHaveLength(0);
  });

  test('public pages never touch the API: a visitor to them does not wait for it, and does not wake it', async ({
    page,
    request,
  }) => {
    for (const path of ['/', '/methodology', '/bot', '/incidents', '/tools/zod-node']) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
    }
    expect(await healthChecks(request)).toBe(0);
  });

  test('POST /api/warm answers at once with nothing in it', async ({ request }) => {
    const t0 = Date.now();
    const res = await request.post('/api/warm');
    expect(res.status()).toBe(204);
    expect(await res.text()).toBe('');
    expect(res.headers()['cache-control']).toBe('no-store');
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  test('the warm-up is a POST: opening the URL in a browser does nothing', async ({ request }) => {
    expect((await request.get('/api/warm')).status()).toBe(405);
  });
});
