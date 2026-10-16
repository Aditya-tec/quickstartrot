import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { StepIR, FailureClass, type RunResult } from '@qsr/core';
import { validateGrounding } from '@qsr/compiler';
import type { Extraction, Target } from '@qsr/core';

// Canaries (spec section 6) are fixture quickstarts with a known answer. They run through the same
// executor as real tools, so a wrong answer means the HARNESS is broken, never the vendor. Their
// plans are committed ("golden") instead of compiled by a model, so a canary cannot be flaky
// because of the compiler; the grounding validator still checks each plan against the live fixture
// page before it runs.

export const CanaryExpectation = z.object({
  outcome: z.enum(['PASS', 'FAIL']),
  /** The class the P5 classifier must assign; recorded here, asserted from phase P5/P6 on. */
  failureClass: FailureClass.nullable(),
  failedStepId: z.string().optional(),
  /** Text that must appear in the output of the run (tails and logs). */
  outputIncludes: z.array(z.string()),
});
export type CanaryExpectation = z.infer<typeof CanaryExpectation>;
const CanaryTable = z.record(z.string(), CanaryExpectation);

const CANARY_DIR = '_canary';

export const isCanarySlug = (slug: string): boolean => slug.startsWith('canary-');

export async function loadCanaryExpectation(
  targetsDir: string,
  slug: string,
): Promise<CanaryExpectation | null> {
  try {
    const table = CanaryTable.parse(
      JSON.parse(await readFile(path.join(targetsDir, CANARY_DIR, 'canaries.json'), 'utf8')),
    );
    return table[slug] ?? null;
  } catch {
    return null;
  }
}

export class GoldenPlanError extends Error {
  override readonly name = 'GoldenPlanError';
}

/**
 * Loads `targets/_canary/<slug>.plan.json` if it exists. The plan must still be grounded in the page
 * as crawled right now, so a fixture edit that invalidates a plan fails loudly instead of silently
 * running something different.
 */
export async function loadGoldenPlan(
  targetsDir: string,
  target: Target,
  extraction: Extraction,
): Promise<StepIR | null> {
  const file = path.join(targetsDir, CANARY_DIR, `${target.slug}.plan.json`);
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return null;
  }
  const parsed = StepIR.safeParse(JSON.parse(text));
  if (!parsed.success)
    throw new GoldenPlanError(
      `${file} is not a valid Step IR: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
    );
  const report = validateGrounding(parsed.data, {
    blocks: extraction.blocks,
    placeholders: target.placeholders,
    language: target.language,
  });
  if (!report.ok) {
    const why = report.violations.map((v) => `${v.stepId} ${v.rule}`).join(', ');
    throw new GoldenPlanError(`${file} is no longer grounded in ${target.docsUrl}: ${why}`);
  }
  return parsed.data;
}

export interface CanaryVerdict {
  ok: boolean;
  problems: string[];
}

/** Compares a run with the canary's expected answer. `output` is the concatenated tails and logs. */
export function checkCanary(
  result: RunResult,
  expected: CanaryExpectation,
  output: string,
): CanaryVerdict {
  const problems: string[] = [];
  if (result.outcome !== expected.outcome)
    problems.push(`expected outcome ${expected.outcome} but got ${result.outcome}`);
  if (expected.failedStepId !== undefined && result.failedStepId !== expected.failedStepId) {
    problems.push(
      `expected step ${expected.failedStepId} to fail but got ${result.failedStepId ?? 'none'}`,
    );
  }
  for (const needle of expected.outputIncludes) {
    if (!output.includes(needle))
      problems.push(`output does not contain ${JSON.stringify(needle)}`);
  }
  return { ok: problems.length === 0, problems };
}
