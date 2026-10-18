import { z } from 'zod';

// What the website's /methodology page says about how well the monitor sees a broken quickstart. It is derived from
// docs/detection-power.json (the results of `qsr mutate`) and from nothing else, so a figure on the page is a figure in
// the document. Browser-safe: zod and plain functions only.
//
// Two things are absent on purpose. There is no overall rate and no sum across the two kinds: install-level mutants
// (a typo in a package name) are stopped by npm and pip whatever the harness does, and averaging them with code-level
// ones would credit the monitor for the package manager. And no rate is stored at all: the page computes a percentage
// from `detected` and `tested` where it is allowed to quote one, and never for level 3.

export const DETECTION_LEVELS = ['L1', 'L2', 'L3', 'local'] as const;
export type DetectionLevel = (typeof DETECTION_LEVELS)[number];

const Count = z.number().int().min(0);

/** One cell of the table: how many planted breakages were tested at a level, and how many the monitor noticed. */
export const DetectionCell = z.object({
  detected: Count,
  tested: Count,
  /** Targets that had at least one tested mutant in this cell. */
  targets: Count,
  /** Mutants with nothing to change in the plan (no site). In no rate. */
  noSite: Count,
  /** Mutants the real grounding validator refused. In no rate. */
  invalid: Count,
  harnessError: Count,
  /** Mutants that would have run but did not, because vendor calls were off. In no rate. */
  notRun: Count,
});
export type DetectionCell = z.infer<typeof DetectionCell>;

const ByLevel = z.object({
  L1: DetectionCell,
  L2: DetectionCell,
  L3: DetectionCell,
  local: DetectionCell,
});

export const DetectionSummary = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.string().min(1),
  /** The version of the harness checks the measurement ran under; results from before versioning are 1. */
  harnessVersion: z.number().int().min(1),
  targetsConsidered: Count,
  targetsMeasured: Count,
  /** Measured targets by the level their control reached; "local" declares no vendor is involved. */
  levelTargets: z.object({ L1: Count, L2: Count, L3: Count, local: Count }),
  /** The targets level 3 rests on. */
  l3Targets: z.array(z.string()),
  /** Every enabled target that reaches level 3 in production (from the target files). Shadow targets are not among them. */
  l3Production: z.array(z.string()),
  /** Of those, the ones the measurement does not cover. */
  l3NotMeasured: z.array(z.string()),
  /** True when every uncovered one is recorded as excluded because vendor calls are off during mutation runs. */
  l3NotMeasuredVendorCallsOff: z.boolean(),
  /** Targets whose level 3 step runs in shadow mode: recorded, not counted. Never also in `l3Targets`. */
  shadowTargets: z.array(z.string()),
  install: ByLevel,
  code: ByLevel,
  /** Code-level result at level 2, per operator: what a level 2 pass can and cannot see. */
  codeL2ByOperator: z.record(z.string(), z.object({ detected: Count, tested: Count })),
});
export type DetectionSummary = z.infer<typeof DetectionSummary>;

/** The operators that change code, as opposed to the install command (stats.ts OPERATOR_KIND, in the cli). */
const CODE_OPERATORS = [
  'renamed_symbol',
  'renamed_method',
  'deep_import',
  'syntax_error',
  'option_misnamed',
] as const;

// Only the fields that are used. Anything else in the file (records, comparisons, survivors) is ignored, not trusted.
const RawCell = z.object({
  detected: Count,
  survived: Count,
  tested: Count,
  invalid: Count,
  notApplicable: Count,
  harnessError: Count,
  notRun: Count,
  targets: Count,
});
const RawByLevel = z.object({ L1: RawCell, L2: RawCell, L3: RawCell, local: RawCell });
const RawResults = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.string().min(1),
  method: z.object({ harnessVersion: z.number().int().min(1).optional() }),
  summary: z.object({
    controls: z.object({
      total: Count,
      included: Count,
      excluded: z.array(z.object({ slug: z.string(), reason: z.string() })),
    }),
    levelTargets: z.object({ L1: Count, L2: Count, L3: Count, local: Count }),
    l3Targets: z.array(z.string()),
    byKind: z.object({ install: RawByLevel, code: RawByLevel }),
    byOperatorLevel: z.record(z.string(), z.record(z.string(), RawCell.partial())),
  }),
});

function toCell(c: z.infer<typeof RawCell>): DetectionCell {
  return {
    detected: c.detected,
    tested: c.tested,
    targets: c.targets,
    noSite: c.notApplicable,
    invalid: c.invalid,
    harnessError: c.harnessError,
    notRun: c.notRun,
  };
}

/**
 * Parses the parsed content of docs/detection-power.json, the slugs of the shadow-L3 targets and the slugs that reach level 3 in
 * production (both from the target files). Throws on any other shape.
 */
export function summariseDetection(
  raw: unknown,
  shadowTargets: readonly string[],
  productionL3: readonly string[],
): DetectionSummary {
  const r = RawResults.parse(raw);
  const both = shadowTargets.filter(
    (t) => r.summary.l3Targets.includes(t) || productionL3.includes(t),
  );
  if (both.length > 0)
    throw new Error(
      `${both.join(', ')} is both counted at level 3 and a shadow target: it cannot be both`,
    );
  const level = (b: z.infer<typeof RawByLevel>) => ({
    L1: toCell(b.L1),
    L2: toCell(b.L2),
    L3: toCell(b.L3),
    local: toCell(b.local),
  });
  const l3NotMeasured = [...productionL3].filter((t) => !r.summary.l3Targets.includes(t)).sort();
  // vendor calls were the reason only if every uncovered quickstart is recorded as excluded for it
  const excludedBecauseVendorCallsOff = new Set(
    r.summary.controls.excluded
      .filter((e) => e.reason.startsWith('vendor calls are off'))
      .map((e) => e.slug),
  );
  const l3NotMeasuredVendorCallsOff =
    l3NotMeasured.length > 0 && l3NotMeasured.every((t) => excludedBecauseVendorCallsOff.has(t));
  const codeL2ByOperator: DetectionSummary['codeL2ByOperator'] = {};
  for (const op of CODE_OPERATORS) {
    const c = r.summary.byOperatorLevel[op]?.['L2'];
    if (c?.tested !== undefined && c.detected !== undefined)
      codeL2ByOperator[op] = { detected: c.detected, tested: c.tested };
  }
  return DetectionSummary.parse({
    schemaVersion: 1,
    generatedAt: r.generatedAt,
    harnessVersion: r.method.harnessVersion ?? 1,
    targetsConsidered: r.summary.controls.total,
    targetsMeasured: r.summary.controls.included,
    levelTargets: r.summary.levelTargets,
    l3Targets: [...r.summary.l3Targets],
    l3Production: [...productionL3].sort(),
    l3NotMeasured,
    l3NotMeasuredVendorCallsOff,
    shadowTargets: [...shadowTargets].sort(),
    install: level(r.summary.byKind.install),
    code: level(r.summary.byKind.code),
    codeL2ByOperator,
  });
}
