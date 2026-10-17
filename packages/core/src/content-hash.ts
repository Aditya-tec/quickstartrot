import { createHash } from 'node:crypto';
import type { ExtractionBlock, VariantsReport } from './extraction.js';
import type { HashIgnoreRule } from './target.js';

/**
 * sha256(JSON.stringify(blocks.map(b => [b.kind, b.lang, b.text]))). Prose wording changes
 * change the hash on purpose: compiles are cached and cheap.
 * When variant markers were resolved (target `extract.variants`) the preference and the removed markers
 * are part of the hash too; without them the payload is exactly the spec's, so existing hashes stay valid.
 *
 * Lives in core so the crawler computes it and the API can re-check it: a runner that posts blocks with
 * somebody else's hash must not be able to poison the plan cache.
 */
/**
 * The target's hashIgnore rules applied to one text, in order, each globally. Used for hashing only (and for the
 * tolerant plan-import check of a target that has rules); never to rewrite what is stored or run.
 */
export function applyHashIgnore(
  text: string,
  rules: readonly HashIgnoreRule[] | undefined,
): string {
  if (rules === undefined || rules.length === 0) return text;
  return rules.reduce((t, r) => t.replace(new RegExp(r.pattern, 'g'), r.replaceWith), text);
}

/**
 * `hashIgnore` (target `extract.hashIgnore`) is for the few pages that print a value that rotates by itself. Without
 * rules the payload is exactly the same as before, byte for byte (pinned by content-hash.test.ts on 51 live pages).
 */
export function contentHash(
  blocks: readonly ExtractionBlock[],
  variants?: VariantsReport,
  hashIgnore?: readonly HashIgnoreRule[],
): string {
  const base = blocks.map((b) => [b.kind, b.lang, applyHashIgnore(b.text, hashIgnore)]);
  const payload = JSON.stringify(
    variants
      ? [
          base,
          variants.prefer,
          variants.blocks.map((b) => [b.originalIndex, b.action, b.keptMarker, b.markers]),
        ]
      : base,
  );
  return createHash('sha256').update(payload).digest('hex');
}
