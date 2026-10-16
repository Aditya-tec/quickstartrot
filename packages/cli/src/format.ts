import type { Step } from '@qsr/core';
import type { CompileResult } from '@qsr/compiler';

const pad = (text: string, width: number): string => text.padEnd(width);
const clip = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 3)}...` : text;

function describeStep(step: Step): string {
  switch (step.kind) {
    case 'shell':
    case 'run':
      return step.command.split('\n').join(' \\n ');
    case 'write_file':
    case 'append_file':
      return `${step.path} (${step.content.split('\n').length} lines)`;
    case 'set_env':
      return `${step.name}=${step.value}`;
    case 'manual':
      return step.reason;
  }
}

function sourceOf(step: Step): string {
  if (step.source === null) return 'harness';
  const { blockIndex, lineStart, lineEnd } = step.source;
  return `#${blockIndex}:${lineStart}${lineEnd === lineStart ? '' : `-${lineEnd}`}`;
}

/** Says whether the model saw the whole page; a truncated page must never look complete. */
function pageLines(t: CompileResult['plan']['truncation']): string[] {
  if (!t.truncated) return [`page:      complete, all ${t.totalBlocks} blocks shown to the model`];
  const lines = [
    `page:      TRUNCATED, ${t.omittedBlocks} of ${t.totalBlocks} blocks not shown to the model (${t.includedBlocks} shown)`,
  ];
  if (t.omittedBlockIndexes.length > 0)
    lines.push(`           omitted blocks: ${t.omittedBlockIndexes.join(', ')}`);
  if (t.clippedBlockIndexes.length > 0)
    lines.push(
      `           clipped blocks (only their beginning was shown): ${t.clippedBlockIndexes.join(', ')}`,
    );
  return lines;
}

/** Human-readable result of `qsr compile`: the verdict, the plan, and the grounding report. */
export function formatCompileResult(
  slug: string,
  result: CompileResult,
  targetLevel: number,
): string {
  const { plan, fromCache, llmCalls } = result;
  const tokensIn = llmCalls.reduce((sum, c) => sum + (c.tokensIn ?? 0), 0);
  const tokensOut = llmCalls.reduce((sum, c) => sum + (c.tokensOut ?? 0), 0);
  const how = fromCache
    ? 'from the plan cache (0 model calls)'
    : `compiled with ${llmCalls.length} model call${llmCalls.length === 1 ? '' : 's'} (${tokensIn} tokens in, ${tokensOut} out)`;

  const lines = [
    `tool:      ${slug}`,
    `plan:      ${plan.accepted ? 'ACCEPTED' : "REJECTED (COMPILER_ERROR: our failure, never shown as the vendor's)"}`,
    `source:    ${how}`,
    `model:     ${plan.model}   compiler version: ${plan.compilerVersion}`,
    `content:   ${plan.contentHash}`,
    ...pageLines(plan.truncation),
  ];

  if (plan.ir) {
    lines.push(
      `level:     plan reaches L${plan.ir.maxLevelReachable} of the target's L${targetLevel}   project setup: ${plan.ir.projectInit}`,
      '',
      'steps:',
    );
    for (const step of plan.ir.steps) {
      lines.push(
        `  ${pad(step.id, 4)} ${pad(step.kind, 12)} ${pad(clip(describeStep(step), 64), 64)} ${sourceOf(step)}`,
      );
    }
    lines.push('', `notes:     ${plan.ir.notes}`);
  }

  const { ok, violations } = plan.groundingReport;
  lines.push(
    '',
    `grounding: ${ok ? 'ok, 0 violations' : `FAILED, ${violations.length} violation${violations.length === 1 ? '' : 's'}`}`,
  );
  for (const v of violations)
    lines.push(`  ${pad(v.stepId, 4)} ${pad(v.rule, 26)} ${clip(v.detail, 110)}`);
  return `${lines.join('\n')}\n`;
}
