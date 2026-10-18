import { expect, test } from '@playwright/test';
import { FIXTURE_SLUGS, RUN_IDS } from './pages';

test.describe('tool page: confirmed incident', () => {
  test('shows the status, the incident, the docs diff and the version diff', async ({ page }) => {
    await page.goto(`/tools/${FIXTURE_SLUGS.failing}`);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(/chalk/i);
    await expect(page.locator('[data-status="failing"]').first()).toBeVisible();
    const card = page.getByTestId('incident-card');
    await expect(card).toContainText(/Quickstart failing since Oct \d+/);
    await expect(card.getByText('What happened')).toBeVisible();
    await expect(card.getByText('Suggested fix')).toBeVisible();
    const diff = page.getByTestId('docs-diff');
    await expect(diff).toContainText("-console.log(chalk.red('hello'));");
    await expect(diff).toContainText("+console.log(chalk.redBright('hello'));");
    await expect(card.getByRole('table')).toContainText('supports-color');
  });

  test('links to the docs and offers badge snippets', async ({ page }) => {
    await page.goto(`/tools/${FIXTURE_SLUGS.failing}`);
    await expect(page.getByRole('link', { name: /Read the quickstart docs/ })).toHaveAttribute(
      'href',
      /^https:\/\//,
    );
    await expect(page.getByText(`/api/badge/${FIXTURE_SLUGS.failing}`).first()).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Markdown' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'HTML' })).toBeVisible();
  });

  test('has a 60-run history strip whose dots open the run', async ({ page }) => {
    await page.goto(`/tools/${FIXTURE_SLUGS.manyRuns}`);
    const dots = page.getByRole('list', { name: /\d+ recent runs?/ }).getByRole('link');
    await expect(dots).toHaveCount(60);
    await dots.last().click();
    await expect(page).toHaveURL(/\/runs\/[0-9a-f-]{36}$/);
  });

  test('expands a redacted log fetched in the browser: gzip decoded, shown as text, virtualized', async ({
    page,
  }) => {
    await page.goto(`/tools/${FIXTURE_SLUGS.failing}`);
    const request = page.waitForResponse((r) => r.url().includes('/api/fixtures/logs/') && r.ok());
    await page
      .getByRole('button', { name: /Show log/ })
      .last()
      .click();
    const response = await request;
    expect(response.headers()['content-type']).toContain('gzip');
    expect(response.headers()['content-encoding']).toBeUndefined();
    const lines = page.getByTestId('log-lines');
    await expect(lines).toContainText('TypeError: chalk.red is not a function');
    // text, not markup
    expect(await lines.locator('script, img, a').count()).toBe(0);
  });

  test('does not fetch any log until it is expanded', async ({ page }) => {
    const logRequests: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('/api/fixtures/logs/')) logRequests.push(r.url());
    });
    await page.goto(`/tools/${FIXTURE_SLUGS.failing}`);
    await page.waitForLoadState('networkidle');
    expect(logRequests).toEqual([]);
  });

  test('the step timeline names the docs source, command, exit code and duration', async ({
    page,
  }) => {
    await page.goto(`/tools/${FIXTURE_SLUGS.failing}`);
    const steps = page.getByRole('list', { name: 'Steps of this run' });
    await expect(steps).toContainText('Docs block');
    await expect(steps).toContainText('npm install acme-sdk');
    await expect(steps).toContainText('Exit code');
    await expect(steps).toContainText('Duration');
  });
});

test.describe('tool page: failure still being verified', () => {
  test('shows "verifying" and no cause, no incident, no log button', async ({ page }) => {
    await page.goto(`/tools/${FIXTURE_SLUGS.verifying}`);
    await expect(page.locator('[data-status="verifying"]').first()).toBeVisible();
    await expect(page.getByTestId('incident-card')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Show log/ })).toHaveCount(0);
    await expect(page.getByText(/is being verified/)).toBeVisible();
    await expect(page.locator('body')).not.toContainText(/failing since/i);
  });

  test('does not say which step failed, and does not call the tool failing', async ({ page }) => {
    await page.goto(`/tools/${FIXTURE_SLUGS.verifying}`);
    const steps = page.getByRole('list', { name: 'Steps of this run' });
    await expect(steps).toContainText('Being verified');
    await expect(steps).not.toContainText('Failed');
    await expect(page.getByText(/failing in a row/)).toHaveCount(0);
    await expect(page.getByText(/\d+ failed in a row/)).toBeVisible();
  });
});

test.describe('other tool states', () => {
  test('healthy tool', async ({ page }) => {
    await page.goto(`/tools/${FIXTURE_SLUGS.healthy}`);
    await expect(page.locator('[data-status="passing"]').first()).toBeVisible();
  });
  test('never-run tool says so', async ({ page }) => {
    await page.goto(`/tools/${FIXTURE_SLUGS.unknown}`);
    await expect(page.locator('[data-status="unknown"]').first()).toBeVisible();
    await expect(page.getByText('No run has been recorded yet.')).toBeVisible();
    await expect(page.getByText('No runs yet')).toBeVisible();
  });
  test('manual-stop tool is "needs a person", not a failure', async ({ page }) => {
    await page.goto(`/tools/${FIXTURE_SLUGS.needsPerson}`);
    await expect(page.locator('[data-status="needs_person"]').first()).toBeVisible();
    await expect(page.locator('[data-status="failing"]')).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText(/Quickstart failing since/);
  });
  test('a very long tool name wraps without breaking the layout', async ({ page }) => {
    await page.goto(`/tools/${FIXTURE_SLUGS.longName}`);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
  test('an unknown slug is a 404 page', async ({ page }) => {
    const res = await page.goto('/tools/not-a-tracked-tool');
    expect(res?.status()).toBe(404);
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  });
});

test.describe('run page', () => {
  test('shows plan, grounding report, truncation record, steps and environment', async ({
    page,
  }) => {
    await page.goto(`/runs/${RUN_IDS.failing}`);
    for (const name of ['Plan', 'Steps', 'Environment'])
      await expect(page.getByRole('heading', { name, level: 2 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Grounding report' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Truncation' })).toBeVisible();
    await expect(page.getByText('Image digest')).toBeVisible();
    await expect(page.getByText('sha256:')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Resolved packages' })).toBeVisible();
    await expect(page.getByText('acme-sdk').first()).toBeVisible();
  });

  test('marks a stale-plan run', async ({ page }) => {
    await page.goto(`/runs/${RUN_IDS.stale}`);
    await expect(page.getByRole('note')).toContainText('Stale plan');
  });

  test('states the harness version of the run, small and factual', async ({ page }) => {
    await page.goto(`/runs/${RUN_IDS.healthy}`);
    await expect(page.getByTestId('harness-version')).toContainText('Harness v2');
    await page.goto(`/runs/${RUN_IDS.stale}`);
    await expect(page.getByTestId('harness-version')).toContainText('Harness v1');
  });

  test('a run of a local-only snippet says it was executed locally and that no vendor was involved', async ({
    page,
  }) => {
    await page.goto(`/runs/${RUN_IDS.stale}`);
    await expect(page.getByTestId('l3-note')).toHaveText(
      'Snippet executed locally (no vendor involved).',
    );
    await page.goto(`/runs/${RUN_IDS.healthy}`);
    await expect(page.getByTestId('l3-note')).toHaveCount(0);
  });

  test('a run of an unreviewed failure shows no outcome detail', async ({ page }) => {
    await page.goto(`/runs/${RUN_IDS.verifying}`);
    await expect(page.getByText('A failure was seen and is being verified.')).toBeVisible();
    await expect(page.getByRole('button', { name: /Show log/ })).toHaveCount(0);
  });

  test('a malformed or unknown run id is a 404', async ({ page }) => {
    expect((await page.goto('/runs/not-a-uuid'))?.status()).toBe(404);
    expect((await page.goto('/runs/00000000-0000-4000-8000-00000000ffff'))?.status()).toBe(404);
  });
});

test.describe('incidents and static pages', () => {
  test('lists only confirmed incidents', async ({ page }) => {
    await page.goto('/incidents');
    await expect(page.getByTestId('incident-card')).toHaveCount(1);
    await expect(page.getByTestId('incident-card')).toContainText('chalk');
  });
  test('methodology explains levels, gates, canaries, review and limits', async ({ page }) => {
    await page.goto('/methodology');
    for (const h of [
      'Levels: what a pass proves',
      'Before a quickstart is called failing',
      'Canaries',
      'What we never do',
      'Limitations',
    ])
      await expect(page.getByRole('heading', { name: h })).toBeVisible();
  });
  test('bot page gives the user agent and the opt-out link', async ({ page }) => {
    await page.goto('/bot');
    await expect(
      page.getByText(/QuickstartRotBot\/1\.0 \(\+http:\/\/localhost:3100\/bot\)/),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: /opt-out form/ })).toHaveAttribute(
      'href',
      /template=opt-out\.yml/,
    );
  });
});
