import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { REVALIDATE_SECRET } from './env';
import { FIXTURE_SLUGS } from './pages';

// POST /api/revalidate really refreshes a cached page. A second server reads a JSON override file on every data
// call, so the test can change "the database" while the server runs: the page keeps showing the cached state until
// the endpoint is called with the secret, and then shows the new one.

const OVERRIDE = path.join(import.meta.dirname, '.tmp', 'override.json');
const slug = FIXTURE_SLUGS.healthy;

function setStatus(status: string | null) {
  mkdirSync(path.dirname(OVERRIDE), { recursive: true });
  if (status === null) rmSync(OVERRIDE, { force: true });
  else writeFileSync(OVERRIDE, JSON.stringify({ tools: { [slug]: { status } } }));
}

test.describe.configure({ mode: 'serial' });
test.afterAll(() => setStatus(null));

test('the page is cached until /api/revalidate is called with the secret', async ({ request }) => {
  setStatus(null);
  await request.post('/api/revalidate', {
    headers: { 'x-revalidate-secret': REVALIDATE_SECRET },
  });

  const status = async (url: string, needle: string) =>
    (await (await request.get(url)).text()).includes(needle);

  expect(await status(`/tools/${slug}`, 'data-status="passing"')).toBe(true);
  expect(await status(`/api/badge/${slug}`, 'quickstart: passing')).toBe(true);

  // the "database" changes: the failure is seen, so the public status becomes "verifying"
  setStatus('DEGRADED');
  expect(await status(`/tools/${slug}`, 'data-status="passing"'), 'still cached').toBe(true);
  expect(await status(`/api/badge/${slug}`, 'quickstart: passing'), 'badge still cached').toBe(
    true,
  );

  // a wrong or missing secret changes nothing
  expect((await request.post('/api/revalidate')).status()).toBe(401);
  expect(
    (
      await request.post('/api/revalidate', {
        headers: { 'x-revalidate-secret': 'wrong-secret-wrong-secret' },
      })
    ).status(),
  ).toBe(401);
  expect((await request.get('/api/revalidate')).status()).toBe(405);
  expect(
    await status(`/tools/${slug}`, 'data-status="passing"'),
    'refused calls changed nothing',
  ).toBe(true);

  // the right secret refreshes it
  const ok = await request.post('/api/revalidate', {
    headers: { 'x-revalidate-secret': REVALIDATE_SECRET },
  });
  expect(ok.status()).toBe(200);
  expect(await status(`/tools/${slug}`, 'data-status="verifying"')).toBe(true);
  expect(await status(`/api/badge/${slug}`, 'quickstart: verifying')).toBe(true);
  expect(await status('/', 'data-status="verifying"')).toBe(true);

  // and back
  setStatus(null);
  await request.post('/api/revalidate', {
    headers: { 'x-revalidate-secret': REVALIDATE_SECRET },
  });
  expect(await status(`/tools/${slug}`, 'data-status="passing"')).toBe(true);
});
