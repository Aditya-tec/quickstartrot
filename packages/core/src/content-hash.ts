import { createHash } from 'node:crypto';
import type { ExtractionBlock, VariantsReport } from './extraction.js';

/**
 * sha256(JSON.stringify(blocks.map(b => [b.kind, b.lang, b.text]))). Prose wording changes
 * change the hash on purpose: compiles are cached and cheap.
 * When variant markers were resolved (target `extract.variants`) the preference and the removed markers
 * are part of the hash too; without them the payload is exactly the spec's, so existing hashes stay valid.
 *
 * Lives in core so the crawler computes it and the API can re-check it: a runner that posts blocks with
 * somebody else's hash must not be able to poison the plan cache.
 */
export function contentHash(blocks: readonly ExtractionBlock[], variants?: VariantsReport): string {
  const base = blocks.map((b) => [b.kind, b.lang, b.text]);
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
