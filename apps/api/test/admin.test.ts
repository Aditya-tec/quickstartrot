import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { adminQueueItems, incidentEvents, incidents, runs, submissions, tools } from '@qsr/db';
import { resetDb, startTestApp, targetInput, type TestApp } from './helpers.js';
import { failedRun } from './fixtures.js';

// /admin/* (spec section 11), behind the bearer token (authentication itself is in app.test.ts).

const dbUrl = inject('testDatabaseUrl');
const d = describe.skipIf(dbUrl === null);

let t: TestApp;
beforeAll(async () => {
  t = await startTestApp(dbUrl as string, {
    config: {
      REVALIDATE_URL: 'https://web.example/api/revalidate',
      REVALIDATE_SECRET: 'revalidate-secret-0123456789',
    },
  });
});
afterAll(async () => {
  await t?.close();
});
beforeEach(async () => {
  await resetDb(t.handle);
  t.fetchCalls.length = 0;
  t.fetchReplies.length = 0;
});

/** A BROKEN tool with an open incident awaiting review, written straight to the database. */
async function brokenTool(slug = 'acme-node') {
  await t.signed('/internal/targets/sync', { targets: [targetInput(slug, { level: 3 })] });
  const cycle = (
    await t.signed('/internal/cycles', { trigger: 'manual', gitSha: 'abcdef1234567' })
  ).json().cycleId as string;
  const ingested = await t.signed('/internal/runs', {
    runResult: failedRun(cycle, 'TypeError: a.b is not a function\n', {}, slug),
    logPaths: {},
  });
  const [tool] = await t.handle.db
    .update(tools)
    .set({
      status: 'BROKEN',
      consecutiveFailures: 2,
      transientStreak: 1,
      lastFailureSignature: 'sig',
      lastFailureClass: 'API_DRIFT',
      statusSince: new Date('2026-10-10T00:00:00Z'),
    })
    .where(eq(tools.slug, slug))
    .returning();
  const [incident] = await t.handle.db
    .insert(incidents)
    .values({
      toolId: (tool as { id: string }).id,
      signature: 'sig',
      failureClass: 'API_DRIFT',
      firstFailingRunId: ingested.json().runId,
      summary: 'LLM draft',
      suggestedFix: 'LLM fix',
    })
    .returning();
  return {
    incident: incident as typeof incidents.$inferSelect,
    tool: tool as typeof tools.$inferSelect,
  };
}
const incidentRow = async (id: string) =>
  (await t.handle.db.select().from(incidents).where(eq(incidents.id, id)))[0];

d('GET /admin/queue', () => {
  it('lists pending incidents, open items and new submissions, newest first', async () => {
    const { incident, tool } = await brokenTool();
    await t.handle.db.insert(adminQueueItems).values([
      { reason: 'unknown_failure', toolId: tool.id, detail: { failureClass: 'UNKNOWN' } },
      { reason: 'crawl_error', toolId: tool.id, detail: { reason: 'missing_root' } },
      { reason: 'compile_deferred', toolId: tool.id, detail: {}, state: 'DONE' },
    ]);
    await t.handle.db
      .insert(submissions)
      .values({ docsUrl: 'https://docs.example.com/q', contact: 'a@b.c', ipHash: 'h' });
    await t.handle.db
      .insert(submissions)
      .values({ docsUrl: 'https://docs.example.com/old', ipHash: 'h', status: 'REJECTED' });
    const body = (await t.admin('GET', '/admin/queue')).json();
    expect(body.pendingIncidents).toMatchObject([
      {
        id: incident.id,
        toolSlug: 'acme-node',
        failureClass: 'API_DRIFT',
        review: 'PENDING_REVIEW',
        summary: 'LLM draft',
      },
    ]);
    expect(body.items.map((i: { reason: string }) => i.reason).sort()).toEqual([
      'crawl_error',
      'unknown_failure',
    ]);
    expect(body.items[0].toolSlug).toBe('acme-node');
    expect(body.submissions).toMatchObject([
      { docsUrl: 'https://docs.example.com/q', contact: 'a@b.c' },
    ]);
  });

  it('is empty when there is nothing to review; confirmed and resolved incidents are not "pending"', async () => {
    expect((await t.admin('GET', '/admin/queue')).json()).toEqual({
      pendingIncidents: [],
      items: [],
      submissions: [],
    });
    const { incident } = await brokenTool();
    await t.handle.db
      .update(incidents)
      .set({ review: 'CONFIRMED' })
      .where(eq(incidents.id, incident.id));
    expect((await t.admin('GET', '/admin/queue')).json().pendingIncidents).toEqual([]);
  });
});

d('POST /admin/incidents/:id/confirm', () => {
  it('stores the EDITED summary and fix, makes the incident public, logs the event and refreshes the web app', async () => {
    const { incident } = await brokenTool();
    const res = await t.admin('POST', `/admin/incidents/${incident.id}/confirm`, {
      summary: 'Edited summary.',
      suggestedFix: 'Edited fix.',
    });
    expect(res.statusCode).toBe(200);
    const after = await incidentRow(incident.id);
    expect(after).toMatchObject({
      review: 'CONFIRMED',
      state: 'OPEN',
      summary: 'Edited summary.',
      suggestedFix: 'Edited fix.',
    });
    expect(after?.confirmedAt?.getTime()).toBe(t.clock.now.getTime());
    const events = await t.handle.db
      .select()
      .from(incidentEvents)
      .where(eq(incidentEvents.incidentId, incident.id));
    expect(events.map((e) => e.type)).toEqual(['confirmed']);
    expect(t.fetchCalls.map((c) => c.url)).toEqual(['https://web.example/api/revalidate']);
    expect(
      (await t.handle.sql`select status from public_tools where slug = 'acme-node'`)[0]?.['status'],
    ).toBe('BROKEN');
    expect(await t.handle.sql`select 1 from public_incidents`).toHaveLength(1);
  });

  it('needs a summary; a fix is optional', async () => {
    const { incident } = await brokenTool();
    expect(
      (await t.admin('POST', `/admin/incidents/${incident.id}/confirm`, { summary: '' }))
        .statusCode,
    ).toBe(400);
    expect(
      (await t.admin('POST', `/admin/incidents/${incident.id}/confirm`, { suggestedFix: 'x' }))
        .statusCode,
    ).toBe(400);
    expect(
      (await t.admin('POST', `/admin/incidents/${incident.id}/confirm`, { summary: 'ok' }))
        .statusCode,
    ).toBe(200);
    expect((await incidentRow(incident.id))?.suggestedFix).toBe('');
  });

  it('404 for an unknown incident; 409 when it is already decided or resolved', async () => {
    const { incident } = await brokenTool();
    expect(
      (
        await t.admin('POST', '/admin/incidents/00000000-0000-4000-8000-000000000000/confirm', {
          summary: 's',
        })
      ).statusCode,
    ).toBe(404);
    await t.admin('POST', `/admin/incidents/${incident.id}/confirm`, { summary: 's' });
    expect(
      (await t.admin('POST', `/admin/incidents/${incident.id}/confirm`, { summary: 's' }))
        .statusCode,
    ).toBe(409);
    await t.handle.db
      .update(incidents)
      .set({ state: 'RESOLVED', review: 'PENDING_REVIEW' })
      .where(eq(incidents.id, incident.id));
    expect(
      (await t.admin('POST', `/admin/incidents/${incident.id}/confirm`, { summary: 's' }))
        .statusCode,
    ).toBe(409);
  });

  it('a web app that is down does not fail the confirmation', async () => {
    const { incident } = await brokenTool();
    t.fetchReplies.push(new Error('web is down'));
    expect(
      (await t.admin('POST', `/admin/incidents/${incident.id}/confirm`, { summary: 's' }))
        .statusCode,
    ).toBe(200);
    expect((await incidentRow(incident.id))?.review).toBe('CONFIRMED');
  });

  it('a malformed id is a 400, not a database error', async () => {
    expect(
      (await t.admin('POST', '/admin/incidents/not-a-uuid/confirm', { summary: 's' })).statusCode,
    ).toBe(400);
  });

  // docs/DISCLOSURE.md: a transient or infrastructure failure is never made public as the vendor's.
  it.each([
    'NETWORK_TRANSIENT',
    'TIMEOUT',
    'CRAWL_ERROR',
    'COMPILER_ERROR',
    'HARNESS_ERROR',
  ] as const)(
    'refuses to confirm a %s incident, and nothing about it becomes public',
    async (failureClass) => {
      const { incident } = await brokenTool();
      await t.handle.db
        .update(incidents)
        .set({ failureClass })
        .where(eq(incidents.id, incident.id));
      const res = await t.admin('POST', `/admin/incidents/${incident.id}/confirm`, {
        summary: 'Looks like the vendor.',
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().detail).toMatch(/never published/i);
      expect(await incidentRow(incident.id)).toMatchObject({
        review: 'PENDING_REVIEW',
        confirmedAt: null,
      });
      expect(await t.handle.sql`select 1 from public_incidents`).toHaveLength(0);
      expect(t.fetchCalls).toHaveLength(0);
    },
  );

  it.each(['DEPENDENCY_RESOLUTION', 'API_DRIFT', 'DOCS_SNIPPET_ERROR', 'RUNTIME_VERSION'] as const)(
    'still confirms a %s incident, the vendor classes',
    async (failureClass) => {
      const { incident } = await brokenTool();
      await t.handle.db
        .update(incidents)
        .set({ failureClass })
        .where(eq(incidents.id, incident.id));
      expect(
        (await t.admin('POST', `/admin/incidents/${incident.id}/confirm`, { summary: 's' }))
          .statusCode,
      ).toBe(200);
    },
  );
});

d('POST /admin/incidents/:id/false-positive', () => {
  it("resolves the incident, resets the tool's streaks, logs the reason and queues a classifier-rule TODO", async () => {
    const { incident, tool } = await brokenTool();
    const res = await t.admin('POST', `/admin/incidents/${incident.id}/false-positive`, {
      reason: 'the docs example was wrong, not the SDK',
    });
    expect(res.statusCode).toBe(200);
    const after = await incidentRow(incident.id);
    expect(after).toMatchObject({ state: 'RESOLVED', review: 'FALSE_POSITIVE' });
    expect(after?.resolvedAt).not.toBeNull();
    const [toolAfter] = await t.handle.db.select().from(tools).where(eq(tools.id, tool.id));
    expect(toolAfter).toMatchObject({
      status: 'HEALTHY',
      consecutiveFailures: 0,
      consecutivePasses: 0,
      transientStreak: 0,
      lastFailureSignature: null,
      lastFailureClass: null,
    });
    expect(toolAfter?.statusSince?.getTime()).toBe(t.clock.now.getTime());
    const events = await t.handle.db
      .select()
      .from(incidentEvents)
      .where(eq(incidentEvents.incidentId, incident.id));
    expect(events).toMatchObject([
      { type: 'false_positive', payload: { reason: 'the docs example was wrong, not the SDK' } },
    ]);
    const [todo] = await t.handle.db
      .select()
      .from(adminQueueItems)
      .where(eq(adminQueueItems.reason, 'rule_todo'));
    expect(todo).toMatchObject({
      toolId: tool.id,
      incidentId: incident.id,
      detail: {
        signature: 'sig',
        failureClass: 'API_DRIFT',
        reason: 'the docs example was wrong, not the SDK',
      },
    });
    expect(t.fetchCalls).toHaveLength(1);
  });

  it('requires a reason; 404 unknown; 409 when already resolved', async () => {
    const { incident } = await brokenTool();
    expect(
      (await t.admin('POST', `/admin/incidents/${incident.id}/false-positive`, {})).statusCode,
    ).toBe(400);
    expect(
      (
        await t.admin(
          'POST',
          '/admin/incidents/00000000-0000-4000-8000-000000000000/false-positive',
          { reason: 'r' },
        )
      ).statusCode,
    ).toBe(404);
    await t.admin('POST', `/admin/incidents/${incident.id}/false-positive`, { reason: 'r' });
    expect(
      (await t.admin('POST', `/admin/incidents/${incident.id}/false-positive`, { reason: 'r' }))
        .statusCode,
    ).toBe(409);
  });

  it('a false positive never counts as a recurrence of anything', async () => {
    // (the status engine is handed only non-false-positive resolved incidents; see cycle-finish.test.ts)
    const { incident } = await brokenTool();
    await t.admin('POST', `/admin/incidents/${incident.id}/false-positive`, { reason: 'r' });
    const rows = await t.handle.db
      .select()
      .from(incidents)
      .where(eq(incidents.review, 'FALSE_POSITIVE'));
    expect(rows).toHaveLength(1);
    expect(await t.handle.db.select().from(runs)).toHaveLength(1); // the run itself is immutable history
  });
});

d('POST /admin/tools/:slug/disable', () => {
  it('pauses the tool for good (a re-sync leaves it off), and refreshes the web app', async () => {
    await t.signed('/internal/targets/sync', { targets: [targetInput('acme-node')] });
    const res = await t.admin('POST', '/admin/tools/acme-node/disable', {
      reason: 'vendor opt-out',
    });
    expect(res.statusCode).toBe(200);
    expect((await t.handle.db.select().from(tools))[0]).toMatchObject({
      enabled: false,
      disabledReason: 'admin',
    });
    await t.signed('/internal/targets/sync', { targets: [targetInput('acme-node')] });
    expect((await t.handle.db.select().from(tools))[0]).toMatchObject({
      enabled: false,
      disabledReason: 'admin',
    });
    expect(t.fetchCalls.length).toBeGreaterThanOrEqual(1);
    expect(
      (await t.signed('/internal/cycles', { trigger: 'manual', gitSha: 'abcdef1234567' })).json()
        .tools,
    ).toEqual([]);
  });

  it('works without a body, is idempotent, and 404s for an unknown slug', async () => {
    await t.signed('/internal/targets/sync', { targets: [targetInput('acme-node')] });
    expect((await t.admin('POST', '/admin/tools/acme-node/disable')).statusCode).toBe(200);
    expect((await t.admin('POST', '/admin/tools/acme-node/disable')).statusCode).toBe(200);
    expect((await t.admin('POST', '/admin/tools/nope-node/disable')).statusCode).toBe(404);
  });
});
