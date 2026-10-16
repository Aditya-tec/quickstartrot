import type { Step, StepIR } from '@qsr/core';
import type { GroundingContext } from './grounding/index.js';
import { applyPlaceholders, citedText } from './grounding/text.js';

/**
 * File content is never taken from the model. For write_file and append_file the model only says
 * WHICH lines of WHICH block become the file; the harness copies those lines (placeholders
 * applied). Measured on real docs, a model asked to reproduce a 33-line file dropped one trailing
 * comma in 2 of 5 runs, which the validator rightly rejected; copying removes that failure class
 * and cuts output tokens. The validator still runs afterwards and checks the result against the
 * citation, so a bad citation is caught exactly as before.
 *
 * A step whose citation cannot be resolved is left untouched, so validation reports the citation.
 */
export function fillFileContent(ir: StepIR, ctx: GroundingContext): StepIR {
  const steps = ir.steps.map((step): Step => {
    if (step.kind !== 'write_file' && step.kind !== 'append_file') return step;
    const block = ctx.blocks.find((b) => b.index === step.source.blockIndex);
    const text = block?.kind === 'code' ? citedText(block, step.source) : null;
    return text === null ? step : { ...step, content: applyPlaceholders(text, ctx.placeholders) };
  });
  return { ...ir, steps };
}
