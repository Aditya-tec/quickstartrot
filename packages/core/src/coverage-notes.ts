import type { Target } from './target.js';

// "What this check does not cover" (2026-10-19). Everything a target's config leaves out or replaces is said in one plain sentence per
// kind, generated here from the config and never typed per target: the tool page, the candidates table and the API all use this function.
// A target that excludes anything has at least one note (cli: coverage-notes.test.ts reads every committed target).

/** The reasons a target may give for leaving blocks out (`extract.ignoreWhy`), each with the sentence the page shows. */
export const IGNORE_REASONS = Object.freeze({
  credentials: 'Account and API-key steps from the docs are not exercised at this level.',
});
export type IgnoreReason = keyof typeof IGNORE_REASONS;

export const COVERAGE_SENTENCES = Object.freeze({
  placeholders:
    'Credentials shown in the docs are replaced by a dummy value, so nothing is checked against a real account.',
  ignoredWithoutReason: 'Some content of the docs page is left out of this check.',
  hashIgnore:
    'A value on the page that changes on every visit is ignored when checking whether the docs changed.',
});

/** One plain sentence for each kind of content the target's config leaves out or replaces; empty when it leaves nothing out. */
export function coverageNotes(target: Target): string[] {
  const notes: string[] = [];
  const { extract } = target;
  if (extract.tab !== undefined)
    notes.push(`Only the "${extract.tab}" tab of the page is checked.`);
  if (extract.variants !== undefined)
    notes.push(
      `The docs show alternatives in one code block; only the one matching "${extract.variants.prefer}" is checked.`,
    );
  if (extract.ignoreBlocksMatching.length > 0)
    notes.push(
      extract.ignoreWhy === undefined
        ? COVERAGE_SENTENCES.ignoredWithoutReason
        : IGNORE_REASONS[extract.ignoreWhy],
    );
  if (Object.keys(target.placeholders).length > 0) notes.push(COVERAGE_SENTENCES.placeholders);
  if (extract.hashIgnore !== undefined && extract.hashIgnore.length > 0)
    notes.push(COVERAGE_SENTENCES.hashIgnore);
  return notes;
}
