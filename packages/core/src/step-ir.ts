import { z } from 'zod';

// Spec section 8: the typed, executable plan the compiler produces.
export const SourceRef = z.object({
  blockIndex: z.number().int(),
  lineStart: z.number().int(),
  lineEnd: z.number().int(),
  /**
   * The cited lines are a code comment (`// npm install x`, `# pip install x`) and the command was taken from it with the comment marker
   * removed. Set by the compiler, only for a target that declares `grounding.installFromComment`, and checked again by the validator.
   * Absent for every other step; absent stays absent, so a stored plan parses and hashes as before.
   */
  commentOnly: z.literal(true).optional(),
});
export type SourceRef = z.infer<typeof SourceRef>;

export const Expect = z.object({
  exitCode: z.number().int().default(0),
  authErrorIsPass: z.boolean().default(false),
  stdoutIncludes: z.array(z.string()).default([]),
  timeoutSec: z.number().int().max(600).default(180),
});
export type Expect = z.infer<typeof Expect>;

export const Step = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('shell'),
    id: z.string(),
    command: z.string(),
    source: SourceRef,
    expect: Expect,
  }),
  z.object({
    kind: z.literal('write_file'),
    id: z.string(),
    path: z.string(),
    content: z.string(),
    source: SourceRef,
  }),
  z.object({
    kind: z.literal('append_file'),
    id: z.string(),
    path: z.string(),
    content: z.string(),
    source: SourceRef,
  }),
  z.object({
    kind: z.literal('set_env'),
    id: z.string(),
    name: z.string(),
    value: z.string(),
    source: SourceRef.nullable(), // dummy values only
  }),
  z.object({
    kind: z.literal('run'),
    id: z.string(),
    command: z.string(),
    source: SourceRef.nullable(), // executes the snippet
    expect: Expect,
  }),
  z.object({
    kind: z.literal('manual'),
    id: z.string(),
    reason: z.string(),
    source: SourceRef, // e.g. 'sign up in dashboard'
  }),
]);
export type Step = z.infer<typeof Step>;
export type StepKind = Step['kind'];

export const StepIR = z.object({
  irVersion: z.literal(1),
  language: z.enum(['node', 'python']),
  projectInit: z.enum(['none', 'npm_init', 'python_venv']), // harness-provided setup
  steps: z.array(Step).min(1).max(30),
  maxLevelReachable: z.number().int().min(1).max(4),
  notes: z.string(),
});
export type StepIR = z.infer<typeof StepIR>;

/** Grounding validator output (spec section 8), stored with the plan and shown on the run page. */
export const GroundingViolation = z.object({
  stepId: z.string(),
  rule: z.string(),
  detail: z.string(),
});
export type GroundingViolation = z.infer<typeof GroundingViolation>;

export const GroundingReport = z.object({
  ok: z.boolean(),
  violations: z.array(GroundingViolation),
});
export type GroundingReport = z.infer<typeof GroundingReport>;
