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

export const Extraction = z.object({
  url: z.url(),
  finalUrl: z.url(), // after redirects
  title: z.string(),
  fetchedAt: z.iso.datetime(),
  blocks: z.array(ExtractionBlock),
  contentHash: z.string(), // sha256 over normalized blocks
});
export type Extraction = z.infer<typeof Extraction>;
