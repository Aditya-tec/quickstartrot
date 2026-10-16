import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createGroqClient, resolveConfig } from '@qsr/compiler';
import {
  classify,
  classifyWithFallback,
  inputFromRunResult,
  unknownClassification,
  type Classification,
  type ClassifierLlm,
} from '@qsr/classifier';
import { RunResult, type Logger } from '@qsr/core';
import { processIo, USAGE, type CliIo } from './commands.js';
import { loadTarget } from './targets.js';

/** The part of a run the classifier needs from the target file (finalizePlan's rule for auth-error-as-pass). */
const authErrorIsPass = (
  target: { level: number; expect: { authErrorIsPass: boolean } },
  stepKind: string | undefined,
): boolean => stepKind === 'run' && target.expect.authErrorIsPass && target.level >= 3;

const describeSource = (c: Classification): string =>
  c.source === 'llm'
    ? `llm (confidence ${String(c.confidence)}, listed for review)`
    : c.source === 'rule'
      ? 'rule'
      : 'none (no rule matched; needs a person)';

/** Human-readable `qsr classify` output. */
function formatClassification(
  result: RunResult,
  stepKind: string | null,
  c: Classification | null,
): string {
  const head = [
    `tool:      ${result.toolSlug}`,
    `run:       ${result.outcome}   reached level L${result.reachedLevel}${
      result.failedStepId
        ? `   failed step ${result.failedStepId}${stepKind ? ` (${stepKind})` : ''}`
        : ''
    }`,
  ];
  if (c === null) return `${[...head, '', 'nothing to classify: the run passed'].join('\n')}\n`;
  return `${[
    ...head,
    '',
    `class:     ${c.failureClass}`,
    `rule:      ${c.ruleId}`,
    `signature: ${c.signature}`,
    `evidence:  ${c.evidenceLine ?? '(none)'}`,
    `source:    ${describeSource(c)}`,
  ].join('\n')}\n`;
}

async function readLogs(dir: string, result: RunResult): Promise<Record<string, string>> {
  const logs: Record<string, string> = {};
  for (const step of result.steps) {
    if (!step.logFile) continue;
    try {
      logs[step.stepId] = await readFile(path.resolve(dir, step.logFile), 'utf8');
    } catch {
      /* the log is optional: the stored tails are used instead */
    }
  }
  return logs;
}

/**
 * `qsr classify <run-result.json>`: classify one stored RunResult (spec section 10). The step logs are
 * read from next to the file (where `qsr run --out` wrote them) and the target file supplies the level
 * and whether auth errors count as a pass. `--llm` enables the Groq fallback for failures no rule matches.
 */
export async function classifyCommand(
  argv: string[],
  _log: Logger,
  io: CliIo = processIo,
  overrides: { llm?: ClassifierLlm } = {},
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: 'boolean', default: false },
      llm: { type: 'boolean', default: false },
      targets: { type: 'string', default: 'targets' },
    },
  });
  const file = positionals[0];
  if (!file) {
    io.stderr(`missing <run-result.json>\n\n${USAGE}`);
    return 2;
  }

  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    io.stderr(`cannot read ${file}\n`);
    return 2;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    io.stderr(`${file} is not valid JSON\n`);
    return 2;
  }
  const parsed = RunResult.safeParse(json);
  if (!parsed.success) {
    io.stderr(
      `${file} is not a RunResult (spec section 9): ${parsed.error.issues[0]?.message ?? 'invalid'}\n`,
    );
    return 2;
  }
  const result = parsed.data;

  let target;
  try {
    target = await loadTarget(path.resolve(values.targets), result.toolSlug);
  } catch (err) {
    io.stderr(
      `${err instanceof Error ? err.message : String(err)} (needed for ${result.toolSlug}'s level and expectations)\n`,
    );
    return 2;
  }

  const failed = result.steps.find((s) => s.stepId === result.failedStepId);
  const input = inputFromRunResult(result, {
    language: target.language,
    targetLevel: target.level,
    authErrorIsPass: authErrorIsPass(target, failed?.kind),
    logs: await readLogs(path.dirname(path.resolve(file)), result),
  });

  let classification: Classification | null = null;
  if (input !== null) {
    if (values.llm) {
      const apiKey = process.env['GROQ_API_KEY'];
      const llm =
        overrides.llm ?? (apiKey ? createGroqClient({ apiKey, config: resolveConfig() }) : null);
      if (llm === null) {
        io.stderr('--llm needs GROQ_API_KEY (put it in .env or the environment)\n');
        return 2;
      }
      classification = await classifyWithFallback(input, { llm });
    } else {
      classification = classify(input) ?? unknownClassification(input);
    }
  }

  io.stdout(
    values.json
      ? `${JSON.stringify({ tool: result.toolSlug, outcome: result.outcome, classification }, null, 2)}\n`
      : formatClassification(result, failed?.kind ?? null, classification),
  );
  return 0;
}
