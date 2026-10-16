import { z } from 'zod';

// Spec section 7: the crawler's normalized, hashable output.
export const ExtractionBlock = z.object({
  index: z.number().int(), // stable order in the page
  kind: z.enum(['code', 'prose', 'heading']),
  lang: z.string().nullable(), // from class="language-ts" etc.
  text: z.string(), // normalized text
  filenameHint: z.string().nullable(), // from code block title bars like "index.ts"
  headingPath: z.array(z.string()), // e.g. ["Quickstart", "Send your first email"]
});
export type ExtractionBlock = z.infer<typeof ExtractionBlock>;

/** What the crawler did with variant markers (target `extract.variants`), recorded so the run can show it. */
export const VariantsReport = z.object({
  prefer: z.string(),
  blocks: z.array(
    z.object({
      originalIndex: z.number().int(), // index before blocks were dropped and renumbered
      blockIndex: z.number().int().nullable(), // index in `blocks`; null when the whole block was dropped
      action: z.enum(['kept_variant', 'dropped_block']),
      keptMarker: z.string().nullable(), // the marker line of the variant that was kept
      markers: z.array(z.string()), // every marker line removed from the block
    }),
  ),
});
export type VariantsReport = z.infer<typeof VariantsReport>;

export const Extraction = z.object({
  url: z.url(),
  finalUrl: z.url(), // after redirects
  title: z.string(),
  fetchedAt: z.iso.datetime(),
  blocks: z.array(ExtractionBlock),
  contentHash: z.string(), // sha256 over normalized blocks
  variants: VariantsReport.optional(),
});
export type Extraction = z.infer<typeof Extraction>;

/**
 * What the compiler left out of a long docs page (spec section 8: the prompt has a character budget).
 * Stored with the plan so a plan built from part of a page is never mistaken for one built from all of it.
 */
export const Truncation = z.object({
  truncated: z.boolean(),
  totalBlocks: z.number().int().min(0),
  includedBlocks: z.number().int().min(0),
  omittedBlocks: z.number().int().min(0),
  omittedBlockIndexes: z.array(z.number().int()), // Extraction block indexes, ascending
  clippedBlockIndexes: z.array(z.number().int()), // blocks cut short as a last resort
});
export type Truncation = z.infer<typeof Truncation>;
