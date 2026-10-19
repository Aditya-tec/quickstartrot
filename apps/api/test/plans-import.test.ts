import { and, eq, sql as dsql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import {
  COMPILER_VERSION,
  compile,
  createMemoryCache,
  resolveConfig,
  type CompiledPlan,
} from '@qsr/compiler';
import { compileConfigHash, Target, contentHash, type Extraction } from '@qsr/core';
import { compiledPlans, docSnapshots, llmCalls, tools } from '@qsr/db';
import { FakeLlm, resetDb, startTestApp, targetInput, type TestApp } from './helpers.js';
import { docsExtraction, goodPlanJson } from './fixtures.js';

// POST /admin/plans/import (P9a): a plan compiled on a developer machine (`qsr plans push`) is accepted into the
// plan cache WITHOUT a model call, but only after the server has checked it itself. It re-runs the deterministic
// grounding validator against the extraction it was sent, recomputes the content hash and the config hash, and
// recomputes the harness-owned fields. A forged extraction can therefore only create a cache entry for a hash that
// no real docs page produces; a tampered plan is rejected; the compiler version must be the server's.

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
const target = (over: Parameters<typeof targetInput>[1] = { level: 3 }): Target =>
  Target.parse(targetInput(SLUG, over));

/** What `qsr compile` does on a developer machine: the real compiler with a scripted model. */
async function localPlan(
  extraction: Extraction = docsExtraction(),
  tgt: Target = target(),
): Promise<CompiledPlan> {
  const llm = new FakeLlm([goodPlanJson()]);
  const { plan } = await compile(tgt, extraction, {
    llm,
    cache: createMemoryCache(),
    config: resolveConfig(),
  });
  expect(plan.accepted).toBe(true);
  return plan;
}

const body = (
  plan: CompiledPlan,
  extraction: Extraction = docsExtraction(),
  tgt: Target = target(),
) => ({
  target: tgt,
  extraction,
  plan: {
    contentHash: plan.contentHash,
    compilerVersion: plan.compilerVersion,
    model: plan.model,
    ir: plan.ir,
  },
});
const importPlan = (b: unknown, token?: string) => t.admin('POST', '/admin/plans/import', b, token);
const rows = () => t.handle.db.select().from(compiledPlans);
const toolRows = () => t.handle.db.select().from(tools);

d('POST /admin/plans/import', () => {
  it('accepts a locally compiled plan, creates the tool, stores the plan and the snapshot, and then serves it from the cache with no model call', async () => {
    const plan = await localPlan();
    const res = await importPlan(body(plan));
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      status: 'imported',
      contentHash: plan.contentHash,
      compilerVersion: COMPILER_VERSION,
      configHash: compileConfigHash(target()),
    });

    const [row] = await rows();
    expect(row).toMatchObject({
      accepted: true,
      contentHash: plan.contentHash,
      configHash: compileConfigHash(target()),
      compilerVersion: COMPILER_VERSION,
    });
    expect((row?.ir as { steps: unknown[] }).steps).toHaveLength(plan.ir?.steps.length ?? -1);
    expect(await toolRows()).toHaveLength(1);
    expect(await t.handle.db.select().from(docSnapshots)).toHaveLength(1);

    // the production compile now hits the cache: the model is never asked
    const cycle = await t.signed('/internal/cycles', {
      trigger: 'manual',
      gitSha: 'abcdef1234567',
    });
    const compiled = await t.signed('/internal/compile', {
      cycleId: cycle.json().cycleId,
      toolSlug: SLUG,
      extraction: docsExtraction(),
    });
    expect(compiled.json()).toMatchObject({ status: 'ok', fromCache: true });
    expect(t.llm.calls).toBe(0);
    expect(await t.handle.db.select().from(llmCalls)).toHaveLength(0);
  });

  it('is idempotent: importing the same plan again changes nothing and says so', async () => {
    const plan = await localPlan();
    expect((await importPlan(body(plan))).json().status).toBe('imported');
    const again = await importPlan(body(plan));
    expect(again.statusCode).toBe(200);
    expect(again.json().status).toBe('already_present');
    expect(await rows()).toHaveLength(1);
    expect(await toolRows()).toHaveLength(1);
  });

  it('replaces a stored REJECTED plan for the same key with the imported accepted one', async () => {
    const plan = await localPlan();
    await importPlan(body(plan));
    await t.handle.db
      .update(compiledPlans)
      .set({ accepted: false, ir: null })
      .where(eq(compiledPlans.contentHash, plan.contentHash));
    const res = await importPlan(body(plan));
    expect(res.json().status).toBe('imported');
    expect((await rows())[0]).toMatchObject({ accepted: true });
  });

  it('rejects a tampered plan: a command that is not in the docs', async () => {
    const plan = await localPlan();
    const ir = structuredClone(plan.ir);
    const shell = ir?.steps.find((s) => s.kind === 'shell');
    if (shell?.kind === 'shell') shell.command = 'npm install evil-package';
    const res = await importPlan(body({ ...plan, ir }));
    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toMatch(/grounding/i);
    expect(await rows()).toHaveLength(0);
    expect(await toolRows()).toHaveLength(0);
  });

  it('rejects a plan with a destructive step, even though it cites the docs', async () => {
    const plan = await localPlan();
    const ir = structuredClone(plan.ir);
    const run = ir?.steps.find((s) => s.kind === 'run');
    if (run?.kind === 'run') run.command = 'rm -rf /';
    const res = await importPlan(body({ ...plan, ir }));
    expect(res.statusCode).toBe(422);
    expect(await rows()).toHaveLength(0);
  });

  it('rejects a plan whose harness-owned fields were altered', async () => {
    const plan = await localPlan();
    const ir = structuredClone(plan.ir);
    if (ir) ir.maxLevelReachable = 1 + ((ir.maxLevelReachable % 4) as number);
    const res = await importPlan(body({ ...plan, ir }));
    expect(res.statusCode).toBe(422);
    expect(await rows()).toHaveLength(0);
  });

  it('rejects an extraction whose content hash does not match its blocks (a forged page)', async () => {
    const plan = await localPlan();
    const extraction = { ...docsExtraction(), contentHash: 'f'.repeat(64) };
    const res = await importPlan({
      ...body(plan, extraction),
      plan: { ...body(plan).plan, contentHash: extraction.contentHash },
    });
    expect(res.statusCode).toBe(400);
    expect(await rows()).toHaveLength(0);
  });

  it('rejects a plan that belongs to a different page than the extraction it came with', async () => {
    const plan = await localPlan();
    const other = docsExtraction({ blocks: docsExtraction().blocks.slice(0, 4) });
    expect(other.contentHash).not.toBe(plan.contentHash);
    const res = await importPlan(body(plan, other));
    expect(res.statusCode).toBe(400);
    expect(await rows()).toHaveLength(0);
  });

  it('rejects a plan compiled by another compiler version', async () => {
    const plan = await localPlan();
    const res = await importPlan(body({ ...plan, compilerVersion: '2000-01-01.1' }));
    expect(res.statusCode).toBe(409);
    expect(res.json().detail).toContain(COMPILER_VERSION);
    expect(await rows()).toHaveLength(0);
  });

  it('rejects a plan for a tool whose stored target differs (the config hash is different)', async () => {
    await t.signed('/internal/targets/sync', { targets: [targetInput(SLUG, { level: 3 })] });
    const other = target({ level: 3, placeholders: { SOMETHING_ELSE: 'qsr_dummy_key' } });
    const plan = await localPlan(docsExtraction(), other);
    const res = await importPlan(body(plan, docsExtraction(), other));
    expect(res.statusCode).toBe(409);
    expect(res.json().detail).toMatch(/config|target/i);
    expect(await rows()).toHaveLength(0);
  });

  it('uses the stored target when the tool exists, and does not create a second tool', async () => {
    await t.signed('/internal/targets/sync', { targets: [targetInput(SLUG, { level: 3 })] });
    const plan = await localPlan();
    expect((await importPlan(body(plan))).statusCode).toBe(200);
    expect(await toolRows()).toHaveLength(1);
    const [tool] = await toolRows();
    expect(tool?.enabled).toBe(true);
  });

  it('creates a tool that is marked enabled: false as a paused one (it must not join the next cycle)', async () => {
    const tgt = target({ level: 3, enabled: false });
    const plan = await localPlan(docsExtraction(), tgt);
    expect((await importPlan(body(plan, docsExtraction(), tgt))).statusCode).toBe(200);
    expect(await toolRows()).toMatchObject([
      { slug: SLUG, enabled: false, disabledReason: 'target_disabled' },
    ]);
  });

  it('rejects a body that is not a plan import at all', async () => {
    expect((await importPlan({ hello: 'world' })).statusCode).toBe(400);
    expect(
      (await importPlan({ ...body(await localPlan()), plan: { contentHash: 'x' } })).statusCode,
    ).toBe(400);
  });

  it('requires the admin token', async () => {
    const plan = await localPlan();
    expect((await importPlan(body(plan), 'wrong-token-wrong-token-wrong-token')).statusCode).toBe(
      401,
    );
    const noAuth = await t.app.inject({
      method: 'POST',
      url: '/admin/plans/import',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(body(plan)),
    });
    expect(noAuth.statusCode).toBe(401);
    expect(await rows()).toHaveLength(0);
  });

  it('never stores two accepted plans for one (tool, content hash, config hash, compiler version)', async () => {
    const plan = await localPlan();
    await Promise.all([importPlan(body(plan)), importPlan(body(plan))]);
    const found = await t.handle.db
      .select()
      .from(compiledPlans)
      .where(
        and(eq(compiledPlans.contentHash, plan.contentHash), eq(compiledPlans.accepted, true)),
      );
    expect(found).toHaveLength(1);
    expect(contentHash(docsExtraction().blocks)).toBe(plan.contentHash);
  });
});

// A target whose docs show the install command only as a code comment (`grounding.installFromComment`): the server re-runs the validator
// with the same permission, for that target and no other, so a plan whose install step is a comment is imported for it and refused otherwise.
d('a target that takes its install from a code comment', () => {
  const COMMENT_BLOCKS = [
    {
      index: 0,
      kind: 'code' as const,
      lang: 'js',
      text: "// npm install acme-sdk\n\nimport { Acme } from 'acme-sdk';\nconst client = new Acme();",
      filenameHint: null,
      headingPath: ['Quickstart'],
    },
  ];
  const withComment = {
    level: 2,
    grounding: {
      installFromComment: true as const,
      reason: 'The page shows its install command only as a comment in the first code block.',
    },
  };
  const commentPlan = (commentOnly: boolean) => ({
    irVersion: 1 as const,
    language: 'node' as const,
    projectInit: 'npm_init' as const,
    steps: [
      {
        kind: 'shell' as const,
        id: 's1',
        command: 'npm install acme-sdk',
        source: {
          blockIndex: 0,
          lineStart: 1,
          lineEnd: 1,
          ...(commentOnly ? { commentOnly: true as const } : {}),
        },
        expect: { exitCode: 0, authErrorIsPass: false, stdoutIncludes: [], timeoutSec: 180 },
      },
      {
        kind: 'write_file' as const,
        id: 's2',
        path: 'index.js',
        content: "import { Acme } from 'acme-sdk';\nconst client = new Acme();",
        source: { blockIndex: 0, lineStart: 3, lineEnd: 4 },
      },
    ],
    maxLevelReachable: 2,
    notes: 'Installs from the comment.',
  });
  const send = (tgt: Target, commentOnly: boolean) => {
    const extraction = docsExtraction({ blocks: COMMENT_BLOCKS });
    return importPlan({
      target: tgt,
      extraction,
      plan: {
        contentHash: extraction.contentHash,
        compilerVersion: COMPILER_VERSION,
        model: 'local-model',
        ir: commentPlan(commentOnly),
      },
    });
  };

  it('is imported, and the stored plan keeps the record that the install came from a comment', async () => {
    const res = await send(Target.parse(targetInput(SLUG, withComment)), true);
    expect(res.statusCode, res.body).toBe(200);
    const [row] = await rows();
    expect(JSON.stringify(row?.ir)).toContain('"commentOnly":true');
  });

  it('is refused when the target does not declare it: the same plan, the same page', async () => {
    const res = await send(Target.parse(targetInput(SLUG, { level: 2 })), true);
    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toContain('command.comment_not_allowed');
    expect(await rows()).toHaveLength(0);
  });

  it('is refused when the install step does not say it came from a comment: the plan has to record it', async () => {
    const res = await send(Target.parse(targetInput(SLUG, withComment)), false);
    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toMatch(/command\.(source_not_shell|mismatch)/);
  });

  it('has its own plan cache key: its config hash differs from the same target without the declaration', () => {
    expect(compileConfigHash(Target.parse(targetInput(SLUG, withComment)))).not.toBe(
      compileConfigHash(Target.parse(targetInput(SLUG, { level: 2 }))),
    );
  });
});

// A tool that `qsr plans push` creates is on probation from its first moment when its target file says so: it is never visible in the public
// views, not even as "not yet tested", between the push and the first sync.
d('a target on probation', () => {
  const probation = { reason: 'New target: public after two valid cycles.' };

  it('is created with the flag, so the public views hold it back from the push on', async () => {
    const tgt = Target.parse(targetInput(SLUG, { level: 3, probation }));
    const plan = await localPlan(docsExtraction(), tgt);
    const res = await importPlan(body(plan, docsExtraction(), tgt));
    expect(res.statusCode, res.body).toBe(200);
    const [row] = await toolRows();
    expect(row?.probation).toBe(true);
    const seen = await t.handle.db.transaction(async (tx) => {
      await tx.execute(dsql`set local role anon`);
      return (await tx.execute(dsql`select slug from public_tools`)) as unknown as unknown[];
    });
    expect(seen).toEqual([]);
  });

  it('a tool without the flag is created without it', async () => {
    const plan = await localPlan();
    await importPlan(body(plan));
    expect((await toolRows())[0]?.probation).toBe(false);
  });
});
