import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { compile, createMemoryCache, resolveConfig, type CompiledPlan } from '@qsr/compiler';
import { contentHash, Target, type Extraction, type ExtractionBlock } from '@qsr/core';
import { compiledPlans, docSnapshots, llmCalls } from '@qsr/db';
import { FakeLlm, resetDb, startTestApp, targetInput, type TestApp } from './helpers.js';
import { docsBlocks, docsExtraction, goodPlanJson } from './fixtures.js';

// Go-live (after P9a): a page that prints a value that rotates by itself (the Ably quickstart prints a generated
// demo key, "xVLyHw.<id>:*****") would cost one compile per rotation. A target can declare extract.hashIgnore; the
// content hash then ignores that value, and ONLY the hash does. These tests pin what happens when a plan compiled
// with key id A meets a live page that now shows key id B, which is the situation the production pipeline is in.

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
});

const SLUG = 'acme-node';
const RULE = {
  pattern: String.raw`\b([A-Za-z0-9_-]{5,8})\.[A-Za-z0-9_-]{5,8}:(?=\*{3,})`,
  replaceWith: '$1.KEYID:',
};
const withRules = Target.parse(
  targetInput(SLUG, { level: 3, extract: { root: 'main', hashIgnore: [RULE] } }),
);
const withoutRules = Target.parse(targetInput(SLUG, { level: 3 }));

/** The fixture page, with a demo key in the file the plan writes. */
function page(keyId: string, tgt: Target = withRules): Extraction {
  const blocks: ExtractionBlock[] = docsBlocks().map((b) =>
    b.index === 4
      ? {
          ...b,
          text: `const acme = require('acme-sdk');\nconst c = acme.connect("xVLyHw.${keyId}:*****");`,
        }
      : b,
  );
  return {
    ...docsExtraction({ blocks }),
    contentHash: contentHash(blocks, undefined, tgt.extract.hashIgnore),
  };
}

async function localPlan(extraction: Extraction, tgt: Target = withRules): Promise<CompiledPlan> {
  const { plan } = await compile(tgt, extraction, {
    llm: new FakeLlm([goodPlanJson()]),
    cache: createMemoryCache(),
    config: resolveConfig(),
  });
  expect(plan.accepted).toBe(true);
  return plan;
}

const body = (plan: CompiledPlan, extraction: Extraction, tgt: Target = withRules) => ({
  target: tgt,
  extraction,
  plan: {
    contentHash: plan.contentHash,
    compilerVersion: plan.compilerVersion,
    model: plan.model,
    ir: plan.ir,
  },
});
const importPlan = (b: unknown) => t.admin('POST', '/admin/plans/import', b);
const writtenFile = (ir: CompiledPlan['ir']): string => {
  const step = ir?.steps.find((s) => s.kind === 'write_file');
  return step?.kind === 'write_file' ? step.content : '';
};

d(
  'a target with hashIgnore: a plan compiled with key id A meets a page that shows key id B',
  () => {
    it('the two pages have the same hash, and without the rule they would not', () => {
      expect(page('ztp85A').contentHash).toBe(page('-gbZ_g').contentHash);
      expect(page('ztp85A', withoutRules).contentHash).not.toBe(
        page('-gbZ_g', withoutRules).contentHash,
      );
    });

    it('the production compile accepts the cached plan (no model call, no COMPILER_ERROR), and the plan still carries key id A', async () => {
      const planA = await localPlan(page('ztp85A'));
      expect((await importPlan(body(planA, page('ztp85A')))).statusCode).toBe(200);
      expect(writtenFile(planA.ir)).toContain('xVLyHw.ztp85A:*****');

      const cycle = await t.signed('/internal/cycles', {
        trigger: 'manual',
        gitSha: 'abcdef1234567',
      });
      const res = await t.signed('/internal/compile', {
        cycleId: cycle.json().cycleId,
        toolSlug: SLUG,
        extraction: page('-gbZ_g'), // the live page, key id B
      });
      expect(res.statusCode, res.body).toBe(200);
      const answer = res.json();
      expect(answer).toMatchObject({ status: 'ok', fromCache: true, stale: false });
      expect(answer.failureClass).toBeUndefined();
      expect(t.llm.calls).toBe(0);
      expect(await t.handle.db.select().from(llmCalls)).toHaveLength(0);
      // what will be executed is the plan as compiled: verbatim text of the page as it was then
      expect(writtenFile(answer.plan.ir)).toContain('xVLyHw.ztp85A:*****');
      expect(writtenFile(answer.plan.ir)).not.toContain('-gbZ_g');
      // one plan, and the snapshot stays the first one seen (the verbatim page of key id A)
      expect(await t.handle.db.select().from(compiledPlans)).toHaveLength(1);
      const snapshots = await t.handle.db.select().from(docSnapshots);
      expect(snapshots).toHaveLength(1);
      expect(JSON.stringify(snapshots[0]?.extraction)).toContain('ztp85A');
    });

    it('plans push after the key rotated: the plan from id A is accepted with the extraction of id B', async () => {
      const planA = await localPlan(page('ztp85A'));
      const res = await importPlan(body(planA, page('-gbZ_g')));
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().status).toBe('imported');
      const [row] = await t.handle.db.select().from(compiledPlans);
      expect(writtenFile(row?.ir as CompiledPlan['ir'])).toContain('xVLyHw.ztp85A:*****'); // stored as sent
    });

    it('the tolerance is only for the key id: a tampered command or an extra change in the page is still refused', async () => {
      const planA = await localPlan(page('ztp85A'));
      const ir = structuredClone(planA.ir);
      const shell = ir?.steps.find((s) => s.kind === 'shell');
      if (shell?.kind === 'shell') shell.command = 'npm install evil-package';
      expect((await importPlan(body({ ...planA, ir }, page('-gbZ_g')))).statusCode).toBe(422);

      const changed = page('-gbZ_g');
      const blocks = changed.blocks.map((b) =>
        b.index === 4 ? { ...b, text: b.text.replace('acme.connect', 'acme.other') } : b,
      );
      const other = { ...changed, blocks, contentHash: contentHash(blocks, undefined, [RULE]) };
      expect(other.contentHash).not.toBe(planA.contentHash);
      expect((await importPlan(body(planA, other))).statusCode).toBe(400);
      expect(await t.handle.db.select().from(compiledPlans)).toHaveLength(0);
    });

    it('the compile route computes the hash the target way: a hash made without the rule is a forged hash', async () => {
      await importPlan(body(await localPlan(page('ztp85A')), page('ztp85A')));
      const cycle = await t.signed('/internal/cycles', {
        trigger: 'manual',
        gitSha: 'abcdef1234567',
      });
      const plain = page('ztp85A', withoutRules); // hashed as a target without rules would
      const res = await t.signed('/internal/compile', {
        cycleId: cycle.json().cycleId,
        toolSlug: SLUG,
        extraction: plain,
      });
      expect(res.statusCode).toBe(400);
    });
  },
);

d('a target without hashIgnore is unchanged', () => {
  it('hashes, imports and compiles exactly as before: a page with a different key id is a different page', async () => {
    const a = page('ztp85A', withoutRules);
    const b = page('-gbZ_g', withoutRules);
    expect(a.contentHash).not.toBe(b.contentHash);
    expect(a.contentHash).toBe(contentHash(a.blocks)); // the plain function, no third argument
    const res = await importPlan(body(await localPlan(a, withoutRules), a, withoutRules));
    expect(res.statusCode, res.body).toBe(200);
    const cycle = await t.signed('/internal/cycles', {
      trigger: 'manual',
      gitSha: 'abcdef1234567',
    });
    // the other key id is a cache miss and the (scripted) model is asked, as it always was
    t.llm.push(goodPlanJson());
    const miss = await t.signed('/internal/compile', {
      cycleId: cycle.json().cycleId,
      toolSlug: SLUG,
      extraction: b,
    });
    expect(miss.json()).toMatchObject({ fromCache: false });
    expect(t.llm.calls).toBe(1);
  });
});
