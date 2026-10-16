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
  }),
  placeholders: z.record(z.string(), z.string()).default({}),
  expect: z
    .object({
      authErrorIsPass: z.boolean().default(false),
      timeoutSec: z.number().int().positive().max(600).default(300),
    })
    .default({ authErrorIsPass: false, timeoutSec: 300 }),
  owners: z
    .object({
      x: z.string().optional(),
      github: z.string().optional(),
    })
    .optional(),
  notes: z.string().optional(),
});
export type Target = z.infer<typeof Target>;
export type TargetInput = z.input<typeof Target>;
