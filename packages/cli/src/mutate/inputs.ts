import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  COMPILER_VERSION,
  createFileCache,
  validateGrounding,
  type CompiledPlan,
} from '@qsr/compiler';
import {
  applyHashIgnore,
  contentHash,
  Extraction,
  type GroundingReport,
  type StepIR,
  type Target,
} from '@qsr/core';
import type { Pair } from './operators.js';

// What `qsr mutate` starts from: the extraction and the accepted plan that the local file cache already holds for a target
// (`qsr plans push` and `qsr run` leave them there). Nothing is crawled and no model is asked: a target without both is
// skipped with its reason.

export const EXTRACTION_SUFFIX = '.extraction.json';

export interface MutationInput {
  target: Target;
  extraction: Extraction;
  plan: CompiledPlan;
  ir: StepIR;
}

export type LoadedInput = { ok: true; input: MutationInput } | { ok: false; reason: string };

/** The file a crawled extraction is stored under, next to the plan cached for the same content hash. */
export const extractionFile = (cacheDir: string, slug: string, hash: string): string =>
  path.join(cacheDir, slug, `${hash}${EXTRACTION_SUFFIX}`);

/** A copy of a JSON value with every string passed through `fn` (the plan is data: only the text changes). */
export function mapStrings<T>(value: T, fn: (s: string) => string): T {
  if (typeof value === 'string') return fn(value) as T;
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn)) as T;
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, fn)])) as T;
  return value;
}

/**
 * The real grounding validator on a pair. A target with hashIgnore rules has a page value that rotates by itself, so the
 * plan and the extraction may differ in exactly that value: both go through the same rules first (as POST
 * /admin/plans/import does), for such a target only.
 */
export function groundingReport(pair: Pair, target: Target): GroundingReport {
  const rules = target.extract.hashIgnore;
  const blocks = rules
    ? pair.extraction.blocks.map((b) => ({ ...b, text: applyHashIgnore(b.text, rules) }))
    : pair.extraction.blocks;
  const ir = rules ? mapStrings(pair.ir, (s) => applyHashIgnore(s, rules)) : pair.ir;
  return validateGrounding(ir, {
    blocks,
    placeholders: target.placeholders,
    language: target.language,
  });
}

export async function loadInput(target: Target, cacheDir: string): Promise<LoadedInput> {
  const dir = path.join(cacheDir, target.slug);
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(EXTRACTION_SUFFIX));
  } catch {
    return { ok: false, reason: 'no cache directory for this target' };
  }
  if (names.length === 0)
    return {
      ok: false,
      reason:
        'no cached extraction (run `qsr plans push` once, which stores the crawled page next to its plan)',
    };

  const cache = createFileCache(cacheDir);
  const found: { extraction: Extraction; plan: CompiledPlan }[] = [];
  for (const name of names) {
    const parsed = Extraction.safeParse(JSON.parse(await readFile(path.join(dir, name), 'utf8')));
    if (!parsed.success) continue;
    const extraction = parsed.data;
    const hash = contentHash(extraction.blocks, extraction.variants, target.extract.hashIgnore);
    if (hash !== name.slice(0, -EXTRACTION_SUFFIX.length)) continue; // a stale or renamed file: not the page its name says
    const plan = await cache.get({
      toolSlug: target.slug,
      contentHash: hash,
      compilerVersion: COMPILER_VERSION,
    });
    if (plan?.accepted && plan.ir)
      found.push({ extraction: { ...extraction, contentHash: hash }, plan });
  }
  const newest = found.sort((a, b) =>
    a.extraction.fetchedAt < b.extraction.fetchedAt ? 1 : -1,
  )[0];
  if (!newest)
    return {
      ok: false,
      reason: `no accepted plan in the cache for a cached extraction (compiler ${COMPILER_VERSION})`,
    };
  return {
    ok: true,
    input: {
      target,
      extraction: newest.extraction,
      plan: newest.plan,
      ir: newest.plan.ir as StepIR,
    },
  };
}
