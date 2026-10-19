import type { ExtractionBlock, SourceRef, Step, StepIR } from '@qsr/core';
import type { GroundingContext } from './index.js';
import { citedText, commandMatches, normalizeCommand } from './text.js';

// Some quickstarts show the install command only inside a code comment:
//     // npm install firecrawl          # pip install firecrawl-py
// A target whose page does this declares `grounding.installFromComment`. For such a target, and nowhere else, an INSTALL command may be
// cited from a comment line. Only the two marker styles below count, the whole cited range must be comment lines, and the command is the
// comment with its marker removed (or a whole sub-command of it). The validator (index.ts) checks all of it again; this file only reads
// comments and records, deterministically, where a command came from (`source.commentOnly`).

/** `//` or `#` at the start of a line. A `#!` shebang is not a comment. */
const COMMENT_LINE = /^\s*(?:\/\/|#(?!!))(.*)$/;

/**
 * The text of the comment(s) in `text` with the markers removed, one line per non-empty comment line, or null when any non-blank line
 * is not a comment (or there is no comment text at all).
 */
export function commentPayload(text: string): string | null {
  const payloads: string[] = [];
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (line.trim() === '') continue;
    const match = COMMENT_LINE.exec(line);
    if (match === null) return null;
    const body = (match[1] as string).trim();
    if (body !== '') payloads.push(body);
  }
  return payloads.length === 0 ? null : payloads.join('\n');
}

function isCommentSource(ref: SourceRef, ctx: GroundingContext): boolean {
  const block = ctx.blocks.find((b) => b.index === ref.blockIndex);
  if (block === undefined || block.kind !== 'code') return false;
  const text = citedText(block, ref);
  return text !== null && commentPayload(text) !== null;
}

/**
 * Sets `source.commentOnly` on every shell step whose cited lines are a comment, for a target that allows it, and removes it from every
 * other step: the compiler decides, never the model. Run, file and manual steps are left as they are.
 */
export function markCommentInstalls(ir: StepIR, ctx: GroundingContext): StepIR {
  const steps = ir.steps.map((step): Step => {
    if (step.kind !== 'shell') return step;
    const { blockIndex, lineStart, lineEnd } = step.source;
    const base: SourceRef = { blockIndex, lineStart, lineEnd };
    const comment = ctx.installFromComment === true && isCommentSource(base, ctx);
    return { ...step, source: comment ? { ...base, commentOnly: true } : base };
  });
  return { ...ir, steps };
}

/**
 * For a violation message: where in `block` the `command` is written as a comment, so a model that cited the wrong lines can cite the
 * right ones. Empty for a target that does not allow commands from comments, and when no comment line holds the command.
 */
export function commentHint(
  block: ExtractionBlock,
  command: string,
  ctx: GroundingContext,
  mapped: (text: string) => string,
): string {
  if (ctx.installFromComment !== true) return '';
  const wanted = normalizeCommand(command);
  const lines = block.text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const payload = commentPayload(lines[i] as string);
    if (payload !== null && commandMatches(wanted, normalizeCommand(mapped(payload)))) {
      return `; the command is written as a comment on line ${i + 1} of block ${block.index}; cite exactly that line`;
    }
  }
  return '';
}
