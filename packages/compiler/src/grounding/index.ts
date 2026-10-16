import type {
  ExtractionBlock,
  GroundingReport,
  GroundingViolation,
  Language,
  SourceRef,
  Step,
  StepIR,
} from '@qsr/core';
import { findDestructive } from './denylist.js';
import { toWorkPath } from './paths.js';
import {
  applyPlaceholders,
  citedText,
  commandMatches,
  hasSuspiciousCharacters,
  mentionsName,
  mentionsPath,
  normalizeCommand,
  normalizeFileContent,
  describeFirstDifference,
} from './text.js';

export { findDestructive } from './denylist.js';
export { toWorkPath } from './paths.js';

/** What the validator needs to know about the page and the target. */
export interface GroundingContext {
  blocks: readonly ExtractionBlock[];
  /** docs placeholder -> dummy replacement (the target's `placeholders`). */
  placeholders: Readonly<Record<string, string>>;
  language: Language;
}

// Spec section 8, "Grounding validator (deterministic, no LLM)". Every rule id below is stored in
// the GroundingReport and shown on the run page.

/** Languages whose blocks are program text or data, never a shell command. */
const NOT_SHELL = new Set([
  'js',
  'javascript',
  'jsx',
  'mjs',
  'cjs',
  'ts',
  'typescript',
  'tsx',
  'json',
  'jsonc',
  'json5',
  'yaml',
  'yml',
  'toml',
  'ini',
  'xml',
  'html',
  'css',
  'scss',
  'sql',
  'python',
  'py',
  'ruby',
  'rb',
  'go',
  'rust',
  'rs',
  'java',
  'kotlin',
  'php',
  'c',
  'cpp',
  'csharp',
  'cs',
  'swift',
  'dockerfile',
  'makefile',
  'graphql',
  'markdown',
  'md',
  'diff',
]);

/** Environment variables a plan may never set: they change how the harness or the runtimes load code. */
const PROTECTED_ENV = new Set([
  'PATH',
  'HOME',
  'SHELL',
  'IFS',
  'USER',
  'PWD',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'BASH_ENV',
  'ENV',
  'NODE_OPTIONS',
  'NODE_PATH',
  'PYTHONPATH',
  'PYTHONSTARTUP',
  'PYTHONHOME',
  'NPM_CONFIG_REGISTRY',
  'PIP_INDEX_URL',
  'PIP_EXTRA_INDEX_URL',
]);

/** File names the compiler may fall back to when the docs name none (spec section 8, prompt rules). */
const DEFAULT_FILES: Record<Language, readonly string[]> = {
  node: ['index.js', 'index.ts'],
  python: ['main.py'],
};

const RUN_ALLOWLIST = /^(node|npx tsx|python) (\S+)$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
/** A cited line that is a variable assignment (`NAME=value`, `export NAME=value`). */
const ENV_ASSIGNMENT = /^\s*(?:export\s+)?[A-Z_][A-Z0-9_]*=/;

const clip = (text: string, max = 100): string =>
  text.length > max ? `${text.slice(0, max - 3)}...` : text;

type Cited =
  { ok: true; block: ExtractionBlock; text: string } | { ok: false; rule: string; detail: string };

function resolveSource(ref: SourceRef, ctx: GroundingContext, needCode: boolean): Cited {
  const block = ctx.blocks.find((b) => b.index === ref.blockIndex);
  if (!block) {
    return {
      ok: false,
      rule: 'source.block_not_found',
      detail: `no block with index ${ref.blockIndex} in the extraction`,
    };
  }
  const text = citedText(block, ref);
  if (text === null) {
    const lines = block.text.split('\n').length;
    return {
      ok: false,
      rule: 'source.range_invalid',
      detail: `lines ${ref.lineStart}-${ref.lineEnd} do not exist in block ${ref.blockIndex} (1 to ${lines})`,
    };
  }
  if (needCode && block.kind !== 'code') {
    return {
      ok: false,
      rule: 'source.not_code',
      detail: `block ${ref.blockIndex} is ${block.kind}, not a code block`,
    };
  }
  return { ok: true, block, text };
}

function textFields(step: Step): string[] {
  switch (step.kind) {
    case 'shell':
    case 'run':
      return [step.command];
    case 'write_file':
    case 'append_file':
      return [step.path, step.content];
    case 'set_env':
      return [step.name, step.value];
    case 'manual':
      return [step.reason];
  }
}

export function validateGrounding(ir: StepIR, ctx: GroundingContext): GroundingReport {
  const violations: GroundingViolation[] = [];
  const add = (stepId: string, rule: string, detail: string): void => {
    violations.push({ stepId, rule, detail });
  };
  const map = ctx.placeholders;
  const mapped = (text: string): string => applyPlaceholders(text, map);

  if (ir.language !== ctx.language) {
    add(
      '*',
      'plan.language_mismatch',
      `plan language is ${ir.language} but the target is ${ctx.language}`,
    );
  }

  const seen = new Set<string>();
  const written = new Set<string>();

  /** Rules 1-4: a command must be the cited lines or a whole sub-command of them. */
  const checkCommand = (step: Step & { command: string }, source: SourceRef): void => {
    const cited = resolveSource(source, ctx, true);
    if (!cited.ok) return add(step.id, cited.rule, cited.detail);
    if (cited.block.lang !== null && NOT_SHELL.has(cited.block.lang)) {
      return add(
        step.id,
        'command.source_not_shell',
        `block ${source.blockIndex} is ${cited.block.lang}, not shell`,
      );
    }
    const docs = normalizeCommand(mapped(cited.text));
    const asWritten = normalizeCommand(step.command);
    if (asWritten === '') return add(step.id, 'command.empty', 'the command is empty');
    if (
      !commandMatches(asWritten, docs) &&
      !commandMatches(normalizeCommand(mapped(step.command)), docs)
    ) {
      add(
        step.id,
        'command.mismatch',
        `"${clip(step.command)}" is not in lines ${source.lineStart}-${source.lineEnd} of block ${source.blockIndex}; the cited lines read "${clip(cited.text, 160)}"${ENV_ASSIGNMENT.test(cited.text) ? '; an environment variable is set with a set_env step, not a shell command, so use a set_env step' : ''}`,
      );
    }
  };

  for (const step of ir.steps) {
    if (seen.has(step.id))
      add(step.id, 'plan.duplicate_step_id', `step id "${step.id}" is used more than once`);
    seen.add(step.id);

    if (textFields(step).some(hasSuspiciousCharacters)) {
      add(
        step.id,
        'text.suspicious_characters',
        'contains zero-width, bidirectional-control or other hidden characters',
      );
    }

    switch (step.kind) {
      case 'shell':
      case 'run': {
        if (step.source !== null) {
          checkCommand(step, step.source);
        } else {
          const m = RUN_ALLOWLIST.exec(normalizeCommand(step.command));
          const file = m ? toWorkPath(m[2] as string) : null; // group 2 always participates
          if (!file?.ok) {
            add(
              step.id,
              'run.not_allowlisted',
              `"${clip(step.command)}" is not node <file>, npx tsx <file> or python <file>`,
            );
          } else if (!written.has(file.path)) {
            const known =
              written.size === 0
                ? 'no file has been written yet'
                : `files written so far: ${[...written].join(', ')}`;
            add(
              step.id,
              'run.file_not_written',
              `${file.path} was not written by an earlier step (${known}); write the file first, then run it with node <file>, npx tsx <file> or python <file>`,
            );
          }
        }
        const destructive = findDestructive(step.command);
        if (destructive !== null) add(step.id, 'denylist', destructive);
        break;
      }

      case 'write_file':
      case 'append_file': {
        const cited = resolveSource(step.source, ctx, true);
        if (!cited.ok) {
          add(step.id, cited.rule, cited.detail);
        } else {
          const docs = normalizeFileContent(mapped(cited.text));
          const content = normalizeFileContent(step.content);
          const mappedContent = normalizeFileContent(mapped(step.content));
          if (content !== docs && mappedContent !== docs) {
            add(
              step.id,
              'file.content_mismatch',
              `content differs from lines ${step.source.lineStart}-${step.source.lineEnd} of block ${step.source.blockIndex}: ${describeFirstDifference(docs, mappedContent)}`,
            );
          }
        }

        const target = toWorkPath(step.path);
        if (!target.ok) {
          if (target.kind === 'outside')
            add(step.id, 'denylist', `writes outside /work: ${target.reason}`);
          else add(step.id, 'file.path_invalid', `"${clip(step.path)}": ${target.reason}`);
        } else {
          written.add(target.path);
          if (cited.ok) {
            const { block } = cited;
            const hint = block.filenameHint === null ? null : toWorkPath(block.filenameHint);
            const grounded =
              block.filenameHint !== null
                ? hint?.ok === true && hint.path === target.path
                : DEFAULT_FILES[ctx.language].includes(target.path) ||
                  ctx.blocks.some((b) => b.kind === 'prose' && mentionsPath(b.text, target.path)) ||
                  mentionsPath(block.text.split('\n')[0] as string, target.path);
            if (!grounded) {
              add(
                step.id,
                'file.path_ungrounded',
                `${target.path} is not named by the docs for block ${block.index}: ${
                  block.filenameHint === null
                    ? `the docs name no file here; use exactly ${DEFAULT_FILES[ctx.language].join(' or ')}`
                    : `the docs name this file ${block.filenameHint}`
                }`,
              );
            }
          }
        }
        break;
      }

      case 'set_env': {
        if (!ENV_NAME.test(step.name))
          add(step.id, 'env.name_invalid', `"${clip(step.name)}" is not a valid variable name`);
        if (PROTECTED_ENV.has(step.name))
          add(step.id, 'env.name_protected', `${step.name} may not be set by a plan`);
        if (step.source !== null) {
          const cited = resolveSource(step.source, ctx, true);
          if (!cited.ok) {
            add(step.id, cited.rule, cited.detail);
          } else {
            const tokens = mapped(cited.text).split(/[\s;&]+/);
            const forms = [step.value, mapped(step.value)].flatMap((v) => [
              `${step.name}=${v}`,
              `${step.name}="${v}"`,
              `${step.name}='${v}'`,
            ]);
            if (!tokens.some((t) => forms.includes(t))) {
              add(
                step.id,
                'env.not_grounded',
                `${step.name}=${clip(step.value, 30)} is not in the cited lines`,
              );
            }
          }
        } else {
          if (!ctx.blocks.some((b) => mentionsName(b.text, step.name))) {
            add(step.id, 'env.not_grounded', `${step.name} does not appear anywhere in the docs`);
          }
          if (!Object.values(map).includes(step.value)) {
            add(
              step.id,
              'env.value_not_placeholder',
              'the value is not a placeholder replacement from the target',
            );
          }
        }
        break;
      }

      case 'manual': {
        const cited = resolveSource(step.source, ctx, false);
        if (!cited.ok) add(step.id, cited.rule, cited.detail);
        break;
      }
    }
  }

  return { ok: violations.length === 0, violations };
}

/** Why a step is destructive (denylist), or null. Covers commands and write paths. */
function destructiveReason(step: Step): string | null {
  if (step.kind === 'shell' || step.kind === 'run') return findDestructive(step.command);
  if (step.kind === 'write_file' || step.kind === 'append_file') {
    const target = toWorkPath(step.path);
    return !target.ok && target.kind === 'outside'
      ? `writes outside /work: ${target.reason}`
      : null;
  }
  return null;
}

/**
 * Spec section 8, rule 7: destructive steps are reported as `manual`. A destructive step whose
 * citation points at real lines becomes a manual step (so the vendor's quickstart is not blamed
 * for a command we refuse to run); one with no valid citation is left alone and fails validation.
 */
export function quarantineDestructive(
  ir: StepIR,
  ctx: GroundingContext,
): { ir: StepIR; quarantined: string[] } {
  const quarantined: string[] = [];
  const reasons: string[] = [];
  const steps = ir.steps.map((step): Step => {
    const reason = destructiveReason(step);
    if (reason === null || step.source === null) return step;
    if (!resolveSource(step.source, ctx, false).ok) return step;
    quarantined.push(step.id);
    reasons.push(`${step.id}: ${reason}`);
    return {
      kind: 'manual',
      id: step.id,
      reason: `Not executed because it is destructive (${reason}).`,
      source: step.source,
    };
  });
  if (quarantined.length === 0) return { ir, quarantined };
  const note = `Replaced by manual steps (denylist): ${reasons.join('; ')}.`;
  return {
    ir: { ...ir, steps, notes: ir.notes === '' ? note : `${ir.notes} ${note}` },
    quarantined,
  };
}

export { interactiveScaffolder, quarantineInteractive } from './interactive.js';
