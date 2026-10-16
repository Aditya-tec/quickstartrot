import type { Step, StepIR } from '@qsr/core';
import type { GroundingContext } from './index.js';
import { citedText } from './text.js';

// Interactive scaffolders (`npm create hono@latest`, `npx create-react-app`) ask the user questions.
// In the sandbox stdin is closed, so they hang or fail, which would look like a broken quickstart
// when it is really a step that needs a human. The prompt tells the model to emit a manual step
// (spec section 8, rule 4); this makes it deterministic instead of a matter of the model's mood.

/** `npm|pnpm|yarn|bun create|init <package>`; `npm init` and `npm init -y` have no package argument. */
const CREATE = /^(?:npm|pnpm|yarn|bun)\s+(?:create|init)\s+(?!-)\S+/;
/** `npx create-*`, `npx @scope/create[-*]`, `npx degit`, also via pnpm dlx / yarn dlx / bunx. */
const EXEC =
  /^(?:npx|bunx|pnpm\s+dlx|yarn\s+dlx)\s+(?:(?:--yes|-y)\s+)?(?:create-\S+|@[^/\s]+\/create(?:-\S+)?|degit)(?=\s|$)/;
/** Flags that tell a scaffolder not to ask. Checked only AFTER the scaffolder name (npx -y is not one). */
const TOLD_NOT_TO_ASK =
  /(?:^|\s)(?:--yes|-y|--default|--defaults|--ci|--no-interactive|--template|-t)(?=\s|=|$)/;

/** Why a command is an interactive scaffolder, or null. Looks at every `&&` / `;` / newline part. */
export function interactiveScaffolder(command: string): string | null {
  for (const part of command.split(/&&|;|\n/)) {
    const text = part.trim();
    const match = CREATE.exec(text) ?? EXEC.exec(text);
    if (match && !TOLD_NOT_TO_ASK.test(text.slice(match[0].length))) {
      return `"${text}" is an interactive scaffolder: it asks questions that only a person can answer`;
    }
  }
  return null;
}

/**
 * Replaces the first interactive scaffolder with a `manual` step and drops every step after it:
 * they depend on what the scaffolder would have created, and the executor stops at a manual step
 * anyway. The plan is then capped at level 1. A step whose citation does not resolve is left alone
 * so validation reports the citation.
 */
export function quarantineInteractive(
  ir: StepIR,
  ctx: GroundingContext,
): { ir: StepIR; quarantined: string | null } {
  const at = ir.steps.findIndex((step) => {
    if (step.kind !== 'shell' && step.kind !== 'run') return false;
    if (step.source === null || interactiveScaffolder(step.command) === null) return false;
    const block = ctx.blocks.find((b) => b.index === step.source?.blockIndex);
    return block !== undefined && citedText(block, step.source) !== null;
  });
  if (at === -1) return { ir, quarantined: null };

  const step = ir.steps[at] as Extract<Step, { kind: 'shell' | 'run' }> & {
    source: NonNullable<Step['source']>;
  };
  const why = interactiveScaffolder(step.command) as string;
  const manual: Step = {
    kind: 'manual',
    id: step.id,
    reason: `Needs a person: ${why}.`,
    source: step.source,
  };
  // The model's notes described steps that are being dropped, so they are replaced, not extended.
  const note = `Stopped at ${step.id}: ${why}. Steps after it were dropped because they depend on what the scaffolder creates.`;
  return {
    ir: {
      ...ir,
      steps: [...ir.steps.slice(0, at), manual],
      maxLevelReachable: 1,
      notes: note,
    },
    quarantined: step.id,
  };
}
