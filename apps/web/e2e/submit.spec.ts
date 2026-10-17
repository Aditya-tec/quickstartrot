import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
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
