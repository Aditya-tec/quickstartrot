import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { COMPILER_VERSION, createGroqClient, resolveConfig } from '@qsr/compiler';
import { adminQueueItems, compiledPlans, docSnapshots, llmCalls, tools } from '@qsr/db';
import { resetDb, startTestApp, targetInput, type TestApp } from './helpers.js';
import { docsBlocks, docsExtraction, garbagePlanJson, goodPlanJson } from './fixtures.js';

// POST /internal/compile (spec section 11) with the token budget (P6): look up by (tool, content hash,
// config hash, COMPILER_VERSION); on a miss call the compiler with a Groq client that logs every call into
// llm_calls. Out of budget, quota, outage or timeout is `deferred`: never COMPILER_ERROR, never a status.

const dbUrl = inject('testDatabaseUrl');
const d = describe.skipIf(dbUrl === null);

let t: TestApp;
beforeAll(async () => {
  t = await startTestApp(dbUrl as string);
});
afterAll(async () => {
  await t?.close();
});
beforeEach(async () => {
  await resetDb(t.handle);
  t.llm.reset();
  t.clock.now = new Date('2026-10-16T12:00:00.000Z');
});

async function setup(slug = 'acme-node', over: Parameters<typeof targetInput>[1] = { level: 3 }) {
  await t.signed('/internal/targets/sync', { targets: [targetInput(slug, over)] });
  const cycle = await t.signed('/internal/cycles', { trigger: 'manual', gitSha: 'abcdef1234567' });
  return cycle.json().cycleId as string;
}
const compile = (cycleId: string, body: Record<string, unknown> = {}, slug = 'acme-node') =>
  t.signed('/internal/compile', { cycleId, toolSlug: slug, extraction: docsExtraction(), ...body });
const plans = () => t.handle.db.select().from(compiledPlans);
const calls = () => t.handle.db.select().from(llmCalls);
const queue = () => t.handle.db.select().from(adminQueueItems);

/** Tokens already spent today, as llm_calls rows. */
async function spend(tokens: number, ageMs = 60_000) {
  await t.handle.db.insert(llmCalls).values({
    purpose: 'compile',
    model: 'm',
    tokensIn: tokens,
    tokensOut: 0,
    latencyMs: 1,
    ok: true,
    createdAt: new Date(t.clock.now.getTime() - ageMs),
  });
}

d('a cache miss compiles, stores and logs', () => {
  it('returns an accepted plan, stores it with its config hash, truncation and the snapshot, and logs the model call', async () => {
    const cycleId = await setup();
    t.llm.push(goodPlanJson());
    const res = await compile(cycleId);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ status: 'ok', fromCache: false, stale: false });
    expect(body.plan).toMatchObject({
      accepted: true,
      compilerVersion: COMPILER_VERSION,
      model: 'fake-model',
      truncation: { truncated: false, totalBlocks: 5 },
      groundingReport: { ok: true, violations: [] },
    });
    expect(body.plan.ir.steps.map((s: { kind: string }) => s.kind)).toEqual([
      'shell',
      'write_file',
      'run',
    ]);
    expect(body.plan.ir.steps[1].content).toContain("require('acme-sdk')"); // copied from the docs by the harness
    expect(body.plan.configHash).toMatch(/^[0-9a-f]{64}$/);

    const [row] = await plans();
    expect(row).toMatchObject({
      id: body.plan.id,
      accepted: true,
      configHash: body.plan.configHash,
      contentHash: body.plan.contentHash,
    });
    const [snap] = await t.handle.db.select().from(docSnapshots);
    expect(snap).toMatchObject({ id: body.snapshotId, contentHash: body.plan.contentHash });
    expect(await calls()).toHaveLength(1);
    expect((await calls())[0]).toMatchObject({
      purpose: 'compile',
      model: 'fake-model',
      tokensIn: 1000,
      tokensOut: 300,
      ok: true,
    });
  });

  it('a second identical request is a cache hit: the same plan, zero model calls', async () => {
    const cycleId = await setup();
    t.llm.push(goodPlanJson());
    const first = (await compile(cycleId)).json();
    const second = (await compile(cycleId)).json();
    expect(second).toMatchObject({ status: 'ok', fromCache: true });
    expect(second.plan.id).toBe(first.plan.id);
    expect(t.llm.calls).toBe(1);
    expect(await calls()).toHaveLength(1);
    expect(await plans()).toHaveLength(1);
    expect(await t.handle.db.select().from(docSnapshots)).toHaveLength(1);
  });

  it('a hit is served even when the budget is spent and there is no model at all', async () => {
    const cycleId = await setup();
    t.llm.push(goodPlanJson());
    await compile(cycleId);
    await spend(500_000);
    const res = await compile(cycleId);
    expect(res.json()).toMatchObject({ status: 'ok', fromCache: true });
  });

  it('changed docs (a new content hash) miss the cache', async () => {
    const cycleId = await setup();
    t.llm.push(goodPlanJson(), goodPlanJson());
    await compile(cycleId);
    const changed = docsExtraction({
      blocks: docsBlocks([
        {
          index: 5,
          kind: 'prose',
          lang: null,
          text: 'A new sentence.',
          filenameHint: null,
          headingPath: ['Quickstart'],
        },
      ]),
    });
    const res = await compile(cycleId, { extraction: changed });
    expect(res.json().fromCache).toBe(false);
    expect(t.llm.calls).toBe(2);
    expect(await plans()).toHaveLength(2);
  });

  it('a changed compile-relevant target field (level) misses the cache; a cosmetic one (name) does not', async () => {
    const cycleId = await setup();
    t.llm.push(goodPlanJson(), goodPlanJson());
    const first = (await compile(cycleId)).json();
    await t.signed('/internal/targets/sync', {
      targets: [targetInput('acme-node', { level: 3, name: 'Renamed', notes: 'edited' })],
    });
    expect((await compile(cycleId)).json()).toMatchObject({ fromCache: true });
    await t.signed('/internal/targets/sync', { targets: [targetInput('acme-node', { level: 2 })] });
    const third = (await compile(cycleId)).json();
    expect(third.fromCache).toBe(false);
    expect(third.plan.configHash).not.toBe(first.plan.configHash);
    expect(await plans()).toHaveLength(2);
  });

  it('a new COMPILER_VERSION misses the cache (the key has all four parts)', async () => {
    const cycleId = await setup();
    t.llm.push(goodPlanJson());
    await compile(cycleId);
    await t.handle.db.update(compiledPlans).set({ compilerVersion: 'older-version' });
    t.llm.push(goodPlanJson());
    expect((await compile(cycleId)).json().fromCache).toBe(false);
  });

  it('records that a long page was truncated, on the plan', async () => {
    const cycleId = await setup();
    t.llm.push(goodPlanJson());
    const long = docsBlocks(
      Array.from({ length: 60 }, (_, i) => ({
        index: 5 + i,
        kind: 'prose' as const,
        lang: null,
        text: `Filler paragraph number ${i} `.repeat(20),
        filenameHint: null,
        headingPath: ['Other'],
      })),
    );
    const res = await compile(cycleId, { extraction: docsExtraction({ blocks: long }) });
    expect(res.json().plan.truncation).toMatchObject({ truncated: true, totalBlocks: 65 });
    expect(res.json().plan.truncation.omittedBlocks).toBeGreaterThan(0);
  });
});

d(
  'modelAllowed: false (the plan job ran out of time): the cache and the stale plan, never the model',
  () => {
    it('a cache hit is still served, with no model call', async () => {
      const cycleId = await setup();
      t.llm.push(goodPlanJson());
      await compile(cycleId);
      const before = (await calls()).length;
      const res = await compile(cycleId, { modelAllowed: false });
      expect(res.json()).toMatchObject({ status: 'ok', fromCache: true, stale: false });
      expect((await calls()).length).toBe(before);
    });

    it('a miss is deferred as llm_timeout, with the most recent accepted plan marked stale', async () => {
      const cycleId = await setup();
      t.llm.push(goodPlanJson());
      const first = (await compile(cycleId)).json();
      const changed = docsExtraction({
        blocks: docsBlocks([
          {
            index: 5,
            kind: 'prose',
            lang: null,
            text: 'New docs.',
            filenameHint: null,
            headingPath: ['Quickstart'],
          },
        ]),
      });
      const res = await t.signed('/internal/compile', {
        cycleId,
        toolSlug: 'acme-node',
        extraction: changed,
        modelAllowed: false,
      });
      expect(res.json()).toMatchObject({ status: 'deferred', reason: 'llm_timeout', stale: true });
      expect(res.json().plan.id).toBe(first.plan.id);
      expect(t.llm.calls).toBe(1); // only the first compile used the model
      expect(await queue()).toHaveLength(0); // a stale plan exists: nothing to tell a person
    });

    it('a miss with no earlier plan is an informational skip, never COMPILER_ERROR', async () => {
      const cycleId = await setup();
      const res = await compile(cycleId, { modelAllowed: false });
      expect(res.json()).toMatchObject({
        status: 'deferred',
        reason: 'llm_timeout',
        stale: false,
        plan: null,
      });
      expect(t.llm.calls).toBe(0);
      expect(await plans()).toHaveLength(0);
      expect((await queue()).map((q) => q.reason)).toEqual(['compile_deferred']);
    });

    it('works with no model configured at all', async () => {
      const none = await startTestApp(dbUrl as string, { llm: null });
      await none.signed('/internal/targets/sync', {
        targets: [targetInput('acme-node', { level: 3 })],
      });
      const cycle = await none.signed('/internal/cycles', {
        trigger: 'manual',
        gitSha: 'abcdef1234567',
      });
      const res = await none.signed('/internal/compile', {
        cycleId: cycle.json().cycleId,
        toolSlug: 'acme-node',
        extraction: docsExtraction(),
        modelAllowed: false,
      });
      expect(res.json()).toMatchObject({ status: 'deferred', reason: 'llm_timeout' });
      await none.close();
    });
  },
);

d('rejected twice is COMPILER_ERROR (ours, never the vendor)', () => {
  it('returns compiler_error with the plan row, queues an item for a person, and never calls the model again for the same docs', async () => {
    const cycleId = await setup();
    t.llm.push(garbagePlanJson(), garbagePlanJson());
    const res = await compile(cycleId);
    expect(res.json()).toMatchObject({
      status: 'compiler_error',
      failureClass: 'COMPILER_ERROR',
      plan: { accepted: false, ir: null },
    });
    expect(t.llm.calls).toBe(2);
    expect((await queue()).map((q) => q.reason)).toEqual(['compiler_error']);
    // cached: the broken page does not hammer the model every cycle, and does not duplicate the item
    const again = await compile(cycleId);
    expect(again.json().status).toBe('compiler_error');
    expect(t.llm.calls).toBe(2);
    expect(await queue()).toHaveLength(1);
  });
});

d('the token budget (GROQ_DAILY_TOKEN_BUDGET, default 150000)', () => {
  it('does NOT call the model when a miss would exceed the last 24 hours of spend, and says deferred / llm_budget', async () => {
    const cycleId = await setup();
    await spend(149_000);
    const res = await compile(cycleId);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: 'deferred',
      reason: 'llm_budget',
      stale: false,
      plan: null,
    });
    expect(t.llm.calls).toBe(0);
    expect(await plans()).toHaveLength(0);
  });

  it('with no earlier plan the tool is skipped this cycle and goes to the admin queue as an informational item', async () => {
    const cycleId = await setup();
    await spend(149_000);
    await compile(cycleId);
    const items = await queue();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      reason: 'compile_deferred',
      detail: { reason: 'llm_budget' },
    });
  });

  it('with an earlier accepted plan (any compiler version) it returns that plan marked stale, and no queue item', async () => {
    const cycleId = await setup();
    t.llm.push(goodPlanJson());
    const first = (await compile(cycleId)).json();
    await t.handle.db.update(compiledPlans).set({ compilerVersion: 'an-older-version' });
    await spend(149_000);
    const changed = docsExtraction({
      blocks: docsBlocks([
        {
          index: 5,
          kind: 'prose',
          lang: null,
          text: 'Docs changed.',
          filenameHint: null,
          headingPath: ['Quickstart'],
        },
      ]),
    });
    const res = await compile(cycleId, { extraction: changed });
    expect(res.json()).toMatchObject({ status: 'deferred', reason: 'llm_budget', stale: true });
    expect(res.json().plan.id).toBe(first.plan.id);
    expect(await queue()).toHaveLength(0);
    expect(t.llm.calls).toBe(1);
  });

  it('the stale plan is the most recent ACCEPTED one: a rejected plan is never served', async () => {
    const cycleId = await setup();
    t.llm.push(garbagePlanJson(), garbagePlanJson());
    await compile(cycleId);
    await spend(149_000);
    const changed = docsExtraction({
      blocks: docsBlocks([
        {
          index: 5,
          kind: 'prose',
          lang: null,
          text: 'Docs changed.',
          filenameHint: null,
          headingPath: ['Quickstart'],
        },
      ]),
    });
    expect((await compile(cycleId, { extraction: changed })).json()).toMatchObject({
      status: 'deferred',
      stale: false,
      plan: null,
    });
  });

  it('only the last 24 hours count: older spend is ignored', async () => {
    const cycleId = await setup();
    await spend(500_000, 25 * 3600 * 1000);
    t.llm.push(goodPlanJson());
    expect((await compile(cycleId)).json().status).toBe('ok');
  });

  it('counts tokens in AND out, failed calls included (as zero when unknown), across every purpose', async () => {
    const cycleId = await setup();
    const at = new Date(t.clock.now.getTime() - 1000);
    await t.handle.db.insert(llmCalls).values([
      {
        purpose: 'classify',
        model: 'm',
        tokensIn: 70_000,
        tokensOut: 79_000,
        latencyMs: 1,
        ok: true,
        createdAt: at,
      },
      {
        purpose: 'summarize',
        model: 'm',
        tokensIn: null,
        tokensOut: null,
        latencyMs: 1,
        ok: false,
        error: 'x',
        createdAt: at,
      },
    ]);
    // 70k in or 79k out alone would leave room; together they do not
    expect((await compile(cycleId)).json()).toMatchObject({
      status: 'deferred',
      reason: 'llm_budget',
    });
  });

  it('the budget is configurable: a budget of 100 defers everything', async () => {
    const small = await startTestApp(dbUrl as string, {
      config: { GROQ_DAILY_TOKEN_BUDGET: '100' },
    });
    await small.signed('/internal/targets/sync', {
      targets: [targetInput('acme-node', { level: 3 })],
    });
    const cycle = await small.signed('/internal/cycles', {
      trigger: 'manual',
      gitSha: 'abcdef1234567',
    });
    const res = await small.signed('/internal/compile', {
      cycleId: cycle.json().cycleId,
      toolSlug: 'acme-node',
      extraction: docsExtraction(),
    });
    expect(res.json()).toMatchObject({ status: 'deferred', reason: 'llm_budget' });
    expect(small.llm.calls).toBe(0);
    await small.close();
  });
});

d('a model failure is deferred, never COMPILER_ERROR', () => {
  const groqWith = (replies: (Response | Error)[], sleeps: number[], fetched: { n: number }) =>
    createGroqClient({
      apiKey: 'test-key',
      config: resolveConfig(),
      maxRetries: 1,
      fetch: (async () => {
        fetched.n++;
        const next = replies.shift();
        if (next instanceof Error) throw next;
        return next ?? new Response('{}', { status: 500 });
      }) as typeof fetch,
      sleep: async (ms) => void sleeps.push(ms),
    });
  const tooMany = () =>
    new Response('{"error":{"message":"rate limit"}}', {
      status: 429,
      headers: { 'retry-after': '3' },
    });

  it('provider 429: honours Retry-After once, then defers (llm_unavailable)', async () => {
    const sleeps: number[] = [];
    const fetched = { n: 0 };
    const app = await startTestApp(dbUrl as string, {
      rawLlm: groqWith([tooMany(), tooMany(), tooMany()], sleeps, fetched),
    });
    await app.signed('/internal/targets/sync', {
      targets: [targetInput('acme-node', { level: 3 })],
    });
    const cycle = await app.signed('/internal/cycles', {
      trigger: 'manual',
      gitSha: 'abcdef1234567',
    });
    const res = await app.signed('/internal/compile', {
      cycleId: cycle.json().cycleId,
      toolSlug: 'acme-node',
      extraction: docsExtraction(),
    });
    expect(res.json()).toMatchObject({ status: 'deferred', reason: 'llm_unavailable' });
    expect(fetched.n).toBe(2); // the first try and exactly one retry
    expect(sleeps).toEqual([3000]);
    expect(await app.handle.db.select().from(compiledPlans)).toHaveLength(0);
    const logged = await app.handle.db.select().from(llmCalls);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ ok: false, purpose: 'compile' });
    expect(logged[0]?.error).toMatch(/429/);
    await app.close();
  });

  it('a provider 429 deferral says how long the provider asked to wait; a 5xx without the header says null', async () => {
    const withHeader = await startTestApp(dbUrl as string, {
      rawLlm: groqWith([tooMany(), tooMany()], [], { n: 0 }),
    });
    await withHeader.signed('/internal/targets/sync', {
      targets: [targetInput('acme-node', { level: 3 })],
    });
    const cycle = await withHeader.signed('/internal/cycles', {
      trigger: 'manual',
      gitSha: 'abcdef1234567',
    });
    const asked = await withHeader.signed('/internal/compile', {
      cycleId: cycle.json().cycleId,
      toolSlug: 'acme-node',
      extraction: docsExtraction(),
    });
    expect(asked.json()).toMatchObject({
      status: 'deferred',
      reason: 'llm_unavailable',
      retryAfterSeconds: 3,
    });
    await withHeader.close();

    const noHeader = await startTestApp(dbUrl as string, {
      rawLlm: groqWith(
        [new Response('x', { status: 503 }), new Response('x', { status: 503 })],
        [],
        { n: 0 },
      ),
    });
    await noHeader.signed('/internal/targets/sync', {
      targets: [targetInput('acme-node', { level: 3 })],
    });
    const cycle2 = await noHeader.signed('/internal/cycles', {
      trigger: 'manual',
      gitSha: 'abcdef1234567',
    });
    const none = await noHeader.signed('/internal/compile', {
      cycleId: cycle2.json().cycleId,
      toolSlug: 'acme-node',
      extraction: docsExtraction(),
    });
    expect(none.json()).toMatchObject({
      status: 'deferred',
      reason: 'llm_unavailable',
      retryAfterSeconds: null,
    });
    await noHeader.close();
  });

  it('provider 429 then success: one retry is enough', async () => {
    const ok = new Response(
      JSON.stringify({
        model: 'm',
        choices: [{ message: { content: goodPlanJson() }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 800, completion_tokens: 200 },
      }),
      { status: 200 },
    );
    const sleeps: number[] = [];
    const app = await startTestApp(dbUrl as string, {
      rawLlm: groqWith([tooMany(), ok], sleeps, { n: 0 }),
    });
    await app.signed('/internal/targets/sync', {
      targets: [targetInput('acme-node', { level: 3 })],
    });
    const cycle = await app.signed('/internal/cycles', {
      trigger: 'manual',
      gitSha: 'abcdef1234567',
    });
    const res = await app.signed('/internal/compile', {
      cycleId: cycle.json().cycleId,
      toolSlug: 'acme-node',
      extraction: docsExtraction(),
    });
    expect(res.json().status).toBe('ok');
    await app.close();
  });

  it('provider 5xx and network errors defer too', async () => {
    for (const reply of [
      new Response('bad gateway', { status: 502 }),
      new Error('socket hang up'),
    ]) {
      const app = await startTestApp(dbUrl as string, {
        rawLlm: groqWith(
          [
            reply,
            reply instanceof Response
              ? new Response('bad gateway', { status: 502 })
              : new Error('socket hang up'),
          ],
          [],
          { n: 0 },
        ),
      });
      await app.signed('/internal/targets/sync', {
        targets: [targetInput('acme-node', { level: 3 })],
      });
      const cycle = await app.signed('/internal/cycles', {
        trigger: 'manual',
        gitSha: 'abcdef1234567',
      });
      const res = await app.signed('/internal/compile', {
        cycleId: cycle.json().cycleId,
        toolSlug: 'acme-node',
        extraction: docsExtraction(),
      });
      expect(res.json()).toMatchObject({ status: 'deferred', reason: 'llm_unavailable' });
      await app.close();
    }
  });

  it('a key the provider rejects defers and tells a person (informational), instead of blaming the docs', async () => {
    const cycleId = await setup();
    t.llm.push(new (await import('@qsr/compiler')).LlmError('invalid api key', 'rejected', 401));
    const res = await compile(cycleId);
    expect(res.json()).toMatchObject({ status: 'deferred', reason: 'llm_unavailable' });
    expect((await queue())[0]).toMatchObject({ reason: 'compile_deferred' });
  });

  it('no model configured (no GROQ_API_KEY): deferred, not a crash', async () => {
    const app = await startTestApp(dbUrl as string, { llm: null });
    await app.signed('/internal/targets/sync', {
      targets: [targetInput('acme-node', { level: 3 })],
    });
    const cycle = await app.signed('/internal/cycles', {
      trigger: 'manual',
      gitSha: 'abcdef1234567',
    });
    const res = await app.signed('/internal/compile', {
      cycleId: cycle.json().cycleId,
      toolSlug: 'acme-node',
      extraction: docsExtraction(),
    });
    expect(res.json()).toMatchObject({ status: 'deferred', reason: 'llm_unavailable' });
    await app.close();
  });

  it('a hard server-side timeout turns a hung model into deferred / llm_timeout', async () => {
    const hung = { complete: () => new Promise<never>(() => undefined) };
    const app = await startTestApp(dbUrl as string, {
      rawLlm: hung,
      config: { COMPILE_TIMEOUT_MS: '1000' },
    });
    await app.signed('/internal/targets/sync', {
      targets: [targetInput('acme-node', { level: 3 })],
    });
    const cycle = await app.signed('/internal/cycles', {
      trigger: 'manual',
      gitSha: 'abcdef1234567',
    });
    const started = Date.now();
    const res = await app.signed('/internal/compile', {
      cycleId: cycle.json().cycleId,
      toolSlug: 'acme-node',
      extraction: docsExtraction(),
    });
    expect(res.json()).toMatchObject({ status: 'deferred', reason: 'llm_timeout' });
    expect(Date.now() - started).toBeLessThan(5000);
    await app.close();
  });

  it('at most 2 model calls per request: a compile that needs a third is deferred, not rejected', async () => {
    const cycleId = await setup();
    // 1st: not a plan (schema retry); 2nd: a plan the validator rejects (a grounding retry would be call 3)
    const ungrounded = JSON.parse(goodPlanJson()) as { steps: { command?: string }[] };
    if (ungrounded.steps[0])
      ungrounded.steps[0].command = 'npm install something-the-docs-never-said';
    t.llm.push(garbagePlanJson(), JSON.stringify(ungrounded), goodPlanJson());
    const res = await compile(cycleId);
    expect(res.json()).toMatchObject({ status: 'deferred', reason: 'llm_budget' });
    expect(t.llm.calls).toBe(2);
    expect(await plans()).toHaveLength(0);
    expect(await calls()).toHaveLength(2);
  });
});

d('crawl errors and bad requests', () => {
  it('a crawl error is recorded for a person and answers crawl_error; nothing is compiled', async () => {
    const cycleId = await setup();
    const res = await t.signed('/internal/compile', {
      cycleId,
      toolSlug: 'acme-node',
      crawlError: { reason: 'missing_root', message: 'selector never became visible' },
    });
    expect(res.json()).toEqual({ status: 'crawl_error', failureClass: 'CRAWL_ERROR' });
    expect(await queue()).toMatchObject([
      { reason: 'crawl_error', detail: { reason: 'missing_root' } },
    ]);
    expect(t.llm.calls).toBe(0);
    await t.signed('/internal/compile', {
      cycleId,
      toolSlug: 'acme-node',
      crawlError: { reason: 'missing_root', message: 'again' },
    });
    expect(await queue()).toHaveLength(1); // one item per (tool, cycle)
  });

  it('needs exactly one of extraction / crawlError', async () => {
    const cycleId = await setup();
    expect(
      (await t.signed('/internal/compile', { cycleId, toolSlug: 'acme-node' })).statusCode,
    ).toBe(400);
    expect((await compile(cycleId, { crawlError: { reason: 'x', message: 'y' } })).statusCode).toBe(
      400,
    );
  });

  it('rejects an extraction whose content hash is not the hash of its blocks (cache poisoning)', async () => {
    const cycleId = await setup();
    const forged = { ...docsExtraction(), contentHash: 'f'.repeat(64) };
    const res = await compile(cycleId, { extraction: forged });
    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toMatch(/content hash/i);
    expect(await plans()).toHaveLength(0);
    expect(await t.handle.db.select().from(docSnapshots)).toHaveLength(0);
  });

  it('unknown tool and unknown cycle are 404; a finished cycle and a disabled tool are 409', async () => {
    const cycleId = await setup();
    expect((await compile(cycleId, {}, 'nope-node')).statusCode).toBe(404);
    expect((await compile('00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
    await t.handle.db
      .update(tools)
      .set({ enabled: false, disabledReason: 'admin' })
      .where(eq(tools.slug, 'acme-node'));
    expect((await compile(cycleId)).statusCode).toBe(409);
    await t.handle.db
      .update(tools)
      .set({ enabled: true, disabledReason: null })
      .where(and(eq(tools.slug, 'acme-node')));
    await t.handle.sql`update probe_cycles set finished_at = now()`;
    expect((await compile(cycleId)).statusCode).toBe(409);
  });

  it('works with a FakeLlm that was given nothing: an empty script is a deferred model failure, not a 500', async () => {
    const cycleId = await setup();
    const res = await compile(cycleId);
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('deferred');
  });
});
