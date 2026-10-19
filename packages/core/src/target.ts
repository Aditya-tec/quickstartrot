import { z } from 'zod';
import { Language } from './taxonomy.js';

const isRegex = (source: string): boolean => {
  try {
    new RegExp(source);
    return true;
  } catch {
    return false;
  }
};

/**
 * Docs that show alternatives inside ONE code block ("// ESM" ... "// CommonJs" ...). The crawler splits
 * on lines matching `splitOn` (each regex is matched against a whole trimmed line, case-insensitively)
 * and keeps the variant whose marker line matches `prefer`. Deterministic, and done before hashing so
 * the content hash is of what we actually run.
 */
export const VariantsConfig = z
  .object({
    splitOn: z.array(z.string().min(1).refine(isRegex, 'not a valid regular expression')).min(1),
    prefer: z.string().min(1).refine(isRegex, 'not a valid regular expression'),
  })
  .strict();
export type VariantsConfig = z.infer<typeof VariantsConfig>;

export const HASH_IGNORE_LIMITS = Object.freeze({
  maxRules: 5,
  maxPatternLength: 200,
  maxReplacementLength: 100,
});

/**
 * Why a regular expression is not accepted as a hashIgnore pattern, or null when it is. The patterns come from the
 * target files (reviewed in a pull request) and run over every block of a docs page, so a pattern that can backtrack
 * catastrophically must not load: no back-references, and no group that contains a quantifier or an alternation and
 * is itself quantified with * + or {n,m}. A conservative scan (escapes and character classes are skipped), not a proof.
 */
export function unsafeRegexReason(source: string): string | null {
  if (source.length > HASH_IGNORE_LIMITS.maxPatternLength)
    return `longer than ${HASH_IGNORE_LIMITS.maxPatternLength} characters`;
  if (/\\[1-9]|\\k</.test(source)) return 'back-references are not allowed';
  const open: { inner: boolean }[] = [];
  let i = 0;
  const quantifierAt = (at: number): boolean => {
    const c = source[at];
    return c === '*' || c === '+' || (c === '{' && /^\{\d+(,\d*)?\}/.test(source.slice(at)));
  };
  while (i < source.length) {
    const c = source[i] as string;
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '[') {
      i++;
      while (i < source.length && source[i] !== ']') i += source[i] === '\\' ? 2 : 1;
      i++;
      const top = open[open.length - 1];
      if (top && quantifierAt(i)) top.inner = true;
      continue;
    }
    if (c === '(') open.push({ inner: false });
    else if (c === '|') {
      const top = open[open.length - 1];
      if (top) top.inner = true;
    } else if (c === ')') {
      const group = open.pop();
      if (group?.inner && quantifierAt(i + 1))
        return 'a quantified group that contains a quantifier or an alternation';
      const parent = open[open.length - 1];
      if (parent && (group?.inner || quantifierAt(i + 1))) parent.inner = true;
    } else if (quantifierAt(i)) {
      const top = open[open.length - 1];
      if (top) top.inner = true;
    }
    i++;
  }
  return null;
}

/**
 * One rule of `extract.hashIgnore`: a regular expression (always applied globally) and its replacement
 * ($1 style group references work). Applied ONLY when the content hash is computed, so a page that shows a value
 * that rotates on every visit (a generated demo key) keeps one plan-cache key. The stored extraction and the plan
 * keep the verbatim text.
 */
export const HashIgnoreRule = z
  .object({
    pattern: z
      .string()
      .min(1)
      .refine(isRegex, 'not a valid regular expression')
      .superRefine((p, ctx) => {
        const reason = unsafeRegexReason(p);
        if (reason !== null) ctx.addIssue({ code: 'custom', message: reason });
      }),
    replaceWith: z.string().max(HASH_IGNORE_LIMITS.maxReplacementLength),
  })
  .strict();
export type HashIgnoreRule = z.infer<typeof HashIgnoreRule>;

// Spec section 6: one YAML file per tracked tool in targets/<slug>.yaml.
export const Target = z.object({
  slug: z
    .string()
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'slug must be kebab-case')
    .max(64),
  name: z.string().min(1),
  docsUrl: z.url({ protocol: /^https?$/ }),
  language: Language,
  level: z.number().int().min(1).max(4),
  runtime: z.object({
    image: z.string().min(1),
    nodeVersion: z.string().optional(),
    pythonVersion: z.string().optional(),
  }),
  extract: z.object({
    root: z.string().min(1),
    codeBlocks: z.string().min(1).default('pre code'),
    tab: z.string().optional(),
    ignoreBlocksMatching: z.array(z.string()).default([]),
    variants: VariantsConfig.optional(),
    /** Absent for every target but the few whose page shows a rotating token; absent stays absent after parsing. */
    hashIgnore: z.array(HashIgnoreRule).max(HASH_IGNORE_LIMITS.maxRules).optional(),
  }),
  placeholders: z.record(z.string(), z.string()).default({}),
  expect: z
    .object({
      authErrorIsPass: z.boolean().default(false),
      timeoutSec: z.number().int().positive().max(600).default(300),
      /**
       * The snippet runs on the runner and no vendor is involved (a library, not an API client). It can never show evidence of reaching a
       * vendor, so it never counts as L3; the run page says it was executed locally. Absent for every other target.
       */
      localOnly: z.literal(true).optional(),
    })
    .default({ authErrorIsPass: false, timeoutSec: 300 }),
  /**
   * Shadow-L3: the L3 step of the plan runs once per cycle and its result is RECORDED, with zero effect on the level, status, incidents,
   * badges or public pages (the level shown for the target is capped at 2 while this is set). A reason is required. Promotion out of
   * shadow is a person's decision after `qsr l3-shadow-report`; it does not recompile the plan (this field is not in the cache key).
   */
  l3: z
    .object({
      mode: z.literal('shadow'),
      reason: z.string().trim().min(10).max(300),
    })
    .strict()
    .optional(),
  owners: z
    .object({
      x: z.string().optional(),
      github: z.string().optional(),
    })
    .optional(),
  notes: z.string().optional(),
  /**
   * Per-target switches for harness-owned checks (P9d). Absent for every target but the few that need one; absent stays absent.
   * `skipExportCheck` turns the experimental export check off for this target (shadow or not) and MUST say why.
   */
  harness: z
    .object({
      skipExportCheck: z.literal(true),
      reason: z.string().trim().min(10).max(300),
    })
    .strict()
    .optional(),
  /**
   * The docs show the install command ONLY inside a code comment (`// npm install x`, `# pip install x`). With this set, the grounding
   * validator accepts an install command cited from a comment line of this target's page (and nowhere else), and the plan records that the
   * command was taken from a comment (`source.commentOnly`). It is part of the plan cache key (compileConfigHash), so no other target's
   * plan is affected. A reason is required. Absent for every target but the few whose page needs it; absent stays absent.
   */
  grounding: z
    .object({
      installFromComment: z.literal(true),
      reason: z.string().trim().min(10).max(300),
    })
    .strict()
    .optional(),
  /**
   * The target is enabled and probed every cycle, but it is on probation: it is not in any public count, in the headline or in a number a
   * post could quote until it has two valid cycles (the public views hide it by themselves; this marks it for the counts made from the
   * files). Remove the field once the site shows the target. Not part of the plan cache key. Absent stays absent.
   */
  probation: z
    .object({
      reason: z.string().trim().min(10).max(300),
    })
    .strict()
    .optional(),
  /**
   * false: the file stays in the repository (with its notes) but the target is not run. A target that is absent
   * here counts as enabled, and stays absent after parsing, so the config hash of every existing target is unchanged.
   */
  enabled: z.boolean().optional(),
});
export type Target = z.infer<typeof Target>;
export type TargetInput = z.input<typeof Target>;

/**
 * Whether a target is in the public counts made from the target files (the claims sheet, the methodology summary, the candidates table):
 * enabled, and not on probation. A target on probation is probed like any other and appears in no number until it leaves probation.
 */
export const countsPublicly = (target: Pick<Target, 'enabled' | 'probation'>): boolean =>
  target.enabled !== false && target.probation === undefined;
