import { z } from 'zod';
import { Language } from './taxonomy.js';

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
