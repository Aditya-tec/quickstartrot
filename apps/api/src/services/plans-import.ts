import { and, eq } from 'drizzle-orm';
import {
  COMPILER_VERSION,
  finalizePlan,
  resolveConfig,
  selectBlocks,
  validateGrounding,
  type GroundingContext,
} from '@qsr/compiler';
import {
  applyHashIgnore,
  compileConfigHash,
  contentHash,
  hashJson,
  Target,
  type Logger,
  type PlanImportBody,
  type PlanImportResponse,
} from '@qsr/core';
import { compiledPlans, docSnapshots, tools } from '@qsr/db';
import type { Ctx } from '../deps.js';
import { HttpError } from '../problem.js';

// POST /admin/plans/import (P9a). A plan compiled on a developer machine goes into the plan cache without a
// model call, so verifying a target locally and then running it in production does not pay for two compiles
// from one shared quota. Nothing the client says is trusted:
//   - the extraction's content hash is recomputed from its blocks (a forged page can only produce a cache entry
//     for a hash that no real docs page has);
//   - the compiler version must be the server's (a plan from other prompts or rules is not a cache hit anyway);
//   - the config hash is derived from the target (and must match the stored tool when there is one);
//   - the deterministic grounding validator is run again, here, against the extraction that was sent: only
//     verbatim docs code gets in, and a destructive command never does;
//   - the harness-owned fields are recomputed and must be what the plan says;
//   - the truncation record is recomputed, not copied.
// The result is stored exactly like a compiled plan, so the production compile hits it as a cache hit.

/** A copy of a JSON value with every string passed through `fn` (the plan is data: numbers and structure are untouched). */
function mapStrings<T>(value: T, fn: (s: string) => string): T {
  if (typeof value === 'string') return fn(value) as T;
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn)) as T;
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, fn)])) as T;
  return value;
}

const unprocessable = (detail: string): HttpError =>
  new HttpError(422, 'Unprocessable Entity', detail);

export async function importPlan(
  ctx: Ctx,
  body: PlanImportBody,
  log: Logger,
): Promise<PlanImportResponse> {
  const { db, deps } = ctx;
  const { extraction, plan } = body;

  if (
    extraction.contentHash !==
    contentHash(extraction.blocks, extraction.variants, body.target.extract.hashIgnore)
  )
    throw new HttpError(
      400,
      'Bad Request',
      'The extraction content hash does not match its blocks.',
    );
  if (plan.contentHash !== extraction.contentHash)
    throw new HttpError(
      400,
      'Bad Request',
      'The plan was compiled from a different page than the extraction that came with it.',
    );
  if (plan.compilerVersion !== COMPILER_VERSION)
    throw new HttpError(
      409,
      'Conflict',
      `The plan was compiled by version ${plan.compilerVersion}; this server uses ${COMPILER_VERSION}. Rebuild the CLI and compile again.`,
    );

  const configHash = compileConfigHash(body.target);
  if (plan.configHash !== undefined && plan.configHash !== configHash)
    throw new HttpError(
      409,
      'Conflict',
      'The config hash sent with the plan is not the hash of the target that came with it.',
    );

  // The tool: the stored one when there is one (its config must agree). Nothing is written until every check passed.
  const [stored] = await db.select().from(tools).where(eq(tools.slug, body.target.slug));
  let target: Target = body.target;
  if (stored) {
    const parsed = Target.safeParse(stored.config);
    if (!parsed.success)
      throw new HttpError(409, 'Conflict', 'The stored target of this tool cannot be read.');
    if (compileConfigHash(parsed.data) !== configHash)
      throw new HttpError(
        409,
        'Conflict',
        'The target differs from the stored one in what a plan depends on (language, level, placeholders, variants): sync the targets first, then push again.',
      );
    target = parsed.data;
  }

  // The deterministic checks, here, on what was sent.
  const config = resolveConfig(
    deps.config.compilerModel ? { model: deps.config.compilerModel } : {},
  );
  const { truncation } = selectBlocks(extraction, config.maxDocsChars);
  // A target with hashIgnore rules has a page value that rotates by itself, so the plan (compiled from an earlier
  // crawl) and the extraction sent now may differ in exactly that value and still be the same page. Only for such a
  // target, and only here, both sides go through the same rules before the validator compares them. The plan that is
  // stored is the one that was sent, with its own verbatim text.
  const rules = target.extract.hashIgnore;
  const ctx2: GroundingContext = {
    blocks:
      rules === undefined
        ? extraction.blocks
        : extraction.blocks.map((b) => ({ ...b, text: applyHashIgnore(b.text, rules) })),
    placeholders: target.placeholders,
    language: target.language,
  };
  const checked =
    rules === undefined ? plan.ir : mapStrings(plan.ir, (s) => applyHashIgnore(s, rules));
  const report = validateGrounding(checked, ctx2);
  if (!report.ok)
    throw unprocessable(
      `The plan failed the grounding validator: ${report.violations
        .slice(0, 8)
        .map((v) => `${v.stepId} ${v.rule}`)
        .join(', ')}`,
    );
  if (hashJson(finalizePlan(plan.ir, target, truncation)) !== hashJson(plan.ir))
    throw unprocessable(
      'The harness-owned fields of the plan (project setup, reachable level, notes) are not what the compiler would set.',
    );

  // Everything checked: now the tool is created if it did not exist.
  let tool = stored;
  if (!tool) {
    await db
      .insert(tools)
      .values({
        slug: target.slug,
        name: target.name,
        docsUrl: target.docsUrl,
        language: target.language,
        level: target.level,
        config: target,
        configHash: hashJson(target),
        enabled: target.enabled !== false,
        disabledReason: target.enabled === false ? 'target_disabled' : null,
      })
      .onConflictDoNothing();
    [tool] = await db.select().from(tools).where(eq(tools.slug, target.slug));
  }
  if (!tool) throw new Error('the tool was not created');

  await db
    .insert(docSnapshots)
    .values({
      toolId: tool.id,
      contentHash: extraction.contentHash,
      extraction,
      firstSeenAt: deps.now(),
      lastSeenAt: deps.now(),
    })
    .onConflictDoUpdate({
      target: [docSnapshots.toolId, docSnapshots.contentHash],
      set: { lastSeenAt: deps.now() },
    });

  const values = {
    toolId: tool.id,
    contentHash: extraction.contentHash,
    configHash,
    compilerVersion: COMPILER_VERSION,
    model: plan.model,
    ir: plan.ir,
    groundingReport: report,
    accepted: true,
    truncation,
  };
  const inserted = await db
    .insert(compiledPlans)
    .values(values)
    .onConflictDoNothing()
    .returning({ id: compiledPlans.id });

  const key = and(
    eq(compiledPlans.toolId, tool.id),
    eq(compiledPlans.contentHash, extraction.contentHash),
    eq(compiledPlans.configHash, configHash),
    eq(compiledPlans.compilerVersion, COMPILER_VERSION),
  );
  let status: PlanImportResponse['status'] = 'imported';
  let planId = inserted[0]?.id;
  if (planId === undefined) {
    const [existing] = await db.select().from(compiledPlans).where(key);
    if (!existing) throw new Error('the plan was neither inserted nor found');
    planId = existing.id;
    if (existing.accepted) {
      status = 'already_present';
    } else {
      // A plan the model could not get past the validator is stored as rejected; a checked, imported one replaces it.
      await db.update(compiledPlans).set(values).where(eq(compiledPlans.id, existing.id));
    }
  }
  log.info(
    { toolSlug: target.slug, contentHash: extraction.contentHash, status, model: plan.model },
    'plan imported',
  );
  return {
    status,
    planId,
    contentHash: extraction.contentHash,
    configHash,
    compilerVersion: COMPILER_VERSION,
  };
}
