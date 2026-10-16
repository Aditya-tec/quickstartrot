import { parseResolved, RUNNER_ENV_KEYS, type RunResult, type Step, type StepIR } from '@qsr/core';
import type { CanaryVerdict } from './canary.js';

const pad = (text: string, width: number): string => text.padEnd(width);
const clip = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 3)}...` : text;
const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

function describeStep(step: Step | undefined): string {
  if (!step) return '';
  switch (step.kind) {
    case 'shell':
    case 'run':
      return step.command.split('\n').join(' \\n ');
    case 'write_file':
    case 'append_file':
      return step.path;
    case 'set_env':
      return `${step.name}=...`;
    case 'manual':
      return step.reason;
  }
}

const ERROR_LINE =
  /error|exception|traceback|failed|not found|cannot|denied|unauthori[sz]ed|forbidden/i;

/**
 * The part of an output tail worth reading: from the first line that looks like an error (so a
 * stack trace does not push the message out of view), at most `n` lines; otherwise the last `n`.
 */
function evidenceLines(text: string | null, n: number): string[] {
  const lines = (text ?? '').split('\n').filter((l) => l.trim() !== '');
  const first = lines.findIndex((l) => ERROR_LINE.test(l));
  return first === -1 ? lines.slice(-n) : lines.slice(first, first + n);
}

export interface RunReport {
  result: RunResult;
  ir: StepIR;
  targetLevel: number;
  resultFile: string;
  canary?: { expectedOutcome: string; verdict: CanaryVerdict } | undefined;
}

/** Human-readable `qsr run` output: the verdict, the step timeline, the evidence, and runner_env. */
export function formatRunResult({
  result,
  ir,
  targetLevel,
  resultFile,
  canary,
}: RunReport): string {
  const byId = new Map(ir.steps.map((s) => [s.id, s]));
  const total = result.steps.reduce((sum, s) => sum + s.durationMs, 0);
  const lines = [
    `tool:      ${result.toolSlug}`,
    `outcome:   ${result.outcome}   reached level L${result.reachedLevel} of the target's L${targetLevel}   (${seconds(total)} in steps)`,
    `image:     ${result.imageDigest}  (${result.runnerEnv['imageSource'] ?? 'unknown'})  ref: ${result.runnerEnv['imageRef'] ?? '?'}`,
    '',
    'timeline:',
  ];

  for (const s of result.steps) {
    const exit = s.exitCode === null ? 'exit -' : `exit ${s.exitCode}`;
    const auth = s.matchedAuthPattern ? `  auth:${s.matchedAuthPattern}` : '';
    lines.push(
      `  #${s.ordinal} ${pad(s.stepId, 4)} ${pad(s.kind, 12)} ${pad(clip(describeStep(byId.get(s.stepId)), 46), 46)} ${pad(s.outcome, 8)} ${pad(exit, 8)} ${pad(seconds(s.durationMs), 7)}${auth}`,
    );
  }

  const failed = result.steps.find((s) => s.stepId === result.failedStepId);
  if (failed?.kind === 'manual') {
    lines.push(
      '',
      `step ${failed.stepId} needs a person: ${describeStep(byId.get(failed.stepId))}`,
    );
  } else if (failed) {
    lines.push('', `evidence from step ${failed.stepId} (${failed.kind}), redacted:`);
    const out = [
      ...evidenceLines(failed.stdoutTail, 5).map((l) => `  out| ${l}`),
      ...evidenceLines(failed.stderrTail, 8).map((l) => `  err| ${l}`),
    ];
    lines.push(...(out.length > 0 ? out : ['  (no output)']));
    if (failed.logFile) lines.push(`  full log: ${failed.logFile}`);
  }

  lines.push('', 'runner_env:');
  for (const [k, v] of Object.entries(result.runnerEnv)) {
    if (k !== RUNNER_ENV_KEYS.resolved) lines.push(`  ${pad(k, 14)} ${v}`);
  }
  const resolved = parseResolved(result.runnerEnv);
  lines.push(
    `  ${pad('resolved', 14)} ${
      Object.keys(resolved).length === 0
        ? '(none)'
        : Object.entries(resolved)
            .map(([n, v]) => `${n}@${v}`)
            .join(', ')
    }`,
  );

  lines.push('', `result:    ${resultFile}`);
  if (canary) {
    lines.push(
      canary.verdict.ok
        ? `canary:    OK - expected ${canary.expectedOutcome} and got it`
        : `canary:    MISMATCH - the harness is not behaving: ${canary.verdict.problems.join('; ')}`,
    );
  }
  return `${lines.join('\n')}\n`;
}
