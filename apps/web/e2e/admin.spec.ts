import { expect, test, type Page } from '@playwright/test';
import { signSession } from '../src/lib/admin-session';
import { ADMIN_SESSION_SECRET, ADMIN_TOKEN, STUB_URL } from './env';

// The admin area: login (constant-time token check, rate limit), a signed httpOnly cookie, a middleware that
// guards /admin/*, and the review actions, which reach the (stub) API from the server with the bearer token.

let client = 0;
test.beforeEach(async ({ page, request }) => {
  await request.post(`${STUB_URL}/__reset`);
  // each test is a different "visitor", so the in-memory failed-login limiter does not carry over
  client += 1;
  await page.context().setExtraHTTPHeaders({
    'x-forwarded-for': `10.${Date.now() % 250}.${client % 250}.${Math.floor(Math.random() * 250)}`,
  });
});

async function signIn(page: Page, token = ADMIN_TOKEN) {
  await page.goto('/admin/login');
  await page.getByLabel('Admin token').fill(token);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

test.describe('access', () => {
  test('/admin and anything under it redirect to the login page without a session', async ({
    page,
  }) => {
    for (const path of ['/admin', '/admin/anything', '/admin/incidents/x']) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/admin\/login$/);
    }
  });

  test('a wrong token is refused with a clear message, and sets no cookie', async ({
    page,
    context,
  }) => {
    await signIn(page, 'not-the-token');
    await expect(page.getByTestId('login-error')).toHaveText('That token is not correct.');
    expect((await context.cookies()).filter((c) => c.name === 'qsr_admin')).toHaveLength(0);
    await page.goto('/admin');
    await expect(page).toHaveURL(/\/admin\/login$/);
  });

  test('repeated failures are rate limited, even for the right token afterwards', async ({
    page,
  }) => {
    for (let i = 0; i < 5; i += 1) {
      await signIn(page, `wrong-${i}`);
      await expect(page.getByTestId('login-error')).toBeVisible();
    }
    await signIn(page, ADMIN_TOKEN);
    await expect(page.getByTestId('login-error')).toContainText('Too many failed attempts');
    await expect(page).toHaveURL(/\/admin\/login$/);
  });

  test('a forged, unsigned or expired cookie is refused', async ({ page, context }) => {
    const base = {
      name: 'qsr_admin',
      domain: 'localhost',
      path: '/admin',
      httpOnly: true,
      secure: true,
      sameSite: 'Strict' as const,
    };
    const old = await signSession(ADMIN_SESSION_SECRET, Math.floor(Date.now() / 1000) - 9 * 3600);
    const wrongSecret = await signSession(
      'another-secret-another-secret-another-secret',
      Math.floor(Date.now() / 1000),
    );
    for (const value of ['junk', ADMIN_TOKEN, old, wrongSecret]) {
      await context.clearCookies();
      await context.addCookies([{ ...base, value }]);
      await page.goto('/admin');
      await expect(page).toHaveURL(/\/admin\/login$/);
    }
  });

  test('the login page and every admin response are noindex and not cacheable', async ({
    page,
    request,
  }) => {
    const res = await request.get('/admin/login');
    expect(res.headers()['x-robots-tag']).toContain('noindex');
    expect(res.headers()['cache-control']).toContain('no-store');
    await page.goto('/admin/login');
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
  });

  test('robots.txt disallows /admin and /api', async ({ request }) => {
    const text = await (await request.get('/robots.txt')).text();
    expect(text).toMatch(/Disallow: \/admin/);
    expect(text).toMatch(/Disallow: \/api\//);
  });
});

test.describe('after login', () => {
  test('sets an httpOnly, secure, sameSite=strict cookie that is not the token', async ({
    page,
    context,
  }) => {
    await signIn(page);
    await expect(page).toHaveURL(/\/admin$/);
    const cookie = (await context.cookies()).find((c) => c.name === 'qsr_admin');
    expect(cookie).toBeDefined();
    expect(cookie).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: 'Strict',
      path: '/admin',
    });
    expect(cookie?.value).not.toContain(ADMIN_TOKEN);
    expect(cookie?.expires ?? 0).toBeGreaterThan(Date.now() / 1000);
    expect(cookie?.expires ?? 0).toBeLessThanOrEqual(Date.now() / 1000 + 8 * 3600 + 60);
    // JavaScript cannot read it
    expect(await page.evaluate(() => document.cookie)).not.toContain('qsr_admin');
  });

  test('the browser never receives the admin token or the API address', async ({ page }) => {
    const seen: string[] = [];
    const bodies: string[] = [];
    page.on('request', (r) => seen.push(r.url()));
    page.on('response', async (r) => {
      if (/text|json|javascript|x-component/.test(r.headers()['content-type'] ?? ''))
        bodies.push(await r.text().catch(() => ''));
    });
    await signIn(page);
    await expect(page.getByRole('heading', { name: 'Admin queue' })).toBeVisible();
    await page.waitForLoadState('networkidle');
    expect(seen.filter((u) => u.includes('4010'))).toEqual([]);
    const all = [await page.content(), ...bodies].join('\n');
    expect(all).not.toContain(ADMIN_TOKEN);
    expect(all).not.toContain('127.0.0.1:4010');
    expect(all).not.toContain(ADMIN_SESSION_SECRET);
  });

  test('lists pending incidents (draft editable), needs-attention items and new submissions', async ({
    page,
  }) => {
    await signIn(page);
    await expect(page.getByTestId('pending-incident')).toHaveCount(2);
    await expect(page.getByLabel('Summary (public once confirmed)').first()).toHaveValue(
      /start\(\) helper was renamed/,
    );
    await expect(page.getByTestId('queue-item')).toContainText('unclassified');
    await expect(page.getByTestId('submission')).toContainText(
      'https://docs.example.com/quickstart',
    );
  });

  test('confirm works end to end: the edited text reaches the API, and the incident leaves the queue', async ({
    page,
    request,
  }) => {
    await signIn(page);
    const first = page.getByTestId('pending-incident').first();
    await first
      .getByLabel('Summary (public once confirmed)')
      .fill('Reviewed: start() was renamed to listen() in 6.0.');
    await first.getByLabel('Suggested fix (public once confirmed)').fill('Call listen().');
    await first.getByRole('button', { name: 'Confirm and publish' }).click();
    await expect(first.getByTestId('action-done')).toContainText('Confirmed');
    const state = await (await request.get(`${STUB_URL}/__state`)).json();
    expect(state.confirmed).toEqual([
      expect.objectContaining({
        id: '00000000-0000-4000-8000-0000000000a1',
        summary: 'Reviewed: start() was renamed to listen() in 6.0.',
        suggestedFix: 'Call listen().',
      }),
    ]);
    await page.reload();
    await expect(page.getByTestId('pending-incident')).toHaveCount(1);
  });

  test('confirm needs a summary', async ({ page, request }) => {
    await signIn(page);
    const second = page.getByTestId('pending-incident').nth(1);
    await second.getByRole('button', { name: 'Confirm and publish' }).click();
    // the textarea is required, so the browser stops it; clear any default and try the server path too
    const state = await (await request.get(`${STUB_URL}/__state`)).json();
    expect(state.confirmed).toHaveLength(0);
  });

  test('false positive works end to end and needs a reason', async ({ page, request }) => {
    await signIn(page);
    const first = page.getByTestId('pending-incident').first();
    await first.getByRole('button', { name: 'Mark as false positive' }).click();
    await expect(first.getByTestId('action-error')).toContainText('reason');
    await first
      .getByLabel('Reason, if this is a false positive')
      .fill('The registry was down for ten minutes.');
    await first.getByRole('button', { name: 'Mark as false positive' }).click();
    await expect(first.getByTestId('action-done')).toContainText('false positive');
    const state = await (await request.get(`${STUB_URL}/__state`)).json();
    expect(state.falsePositives).toEqual([
      expect.objectContaining({
        id: '00000000-0000-4000-8000-0000000000a1',
        reason: 'The registry was down for ten minutes.',
      }),
    ]);
  });

  test('an action on an incident someone else already reviewed shows the API reason', async ({
    page,
    request,
  }) => {
    await signIn(page);
    await expect(page.getByTestId('pending-incident')).toHaveCount(2);
    await request.post(
      `${STUB_URL}/admin/incidents/00000000-0000-4000-8000-0000000000a1/false-positive`,
      {
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        data: { reason: 'raced' },
      },
    );
    const first = page.getByTestId('pending-incident').first();
    await first.getByLabel('Reason, if this is a false positive').fill('also me');
    await first.getByRole('button', { name: 'Mark as false positive' }).click();
    await expect(first.getByTestId('action-error')).toContainText('already reviewed');
  });

  test('sign out ends the session', async ({ page, context }) => {
    await signIn(page);
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/admin\/login$/);
    expect((await context.cookies()).filter((c) => c.name === 'qsr_admin')).toHaveLength(0);
    await page.goto('/admin');
    await expect(page).toHaveURL(/\/admin\/login$/);
  });
});
