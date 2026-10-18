import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { VENDOR_FAILURE_CLASSES } from '@qsr/core/public';
import { FACTS, words } from '@/lib/facts';
import { MethodologyContent } from './methodology-content';

const text = (): string =>
  renderToStaticMarkup(<MethodologyContent facts={FACTS} />)
    .replaceAll(/<[^>]+>/g, ' ')
    .replaceAll(/&[a-z]+;|&#x?\d+;/gi, ' ')
    .replaceAll(/\s+/g, ' ');

describe('/methodology: before a quickstart is called failing', () => {
  // apps/api confirmIncident refuses every class that is not a vendor class (admin.test.ts pins it).
  it('says a transient failure is never published as the vendor’s, which the review screen enforces', () => {
    const t = text();
    expect(t).toMatch(/transient failures in a row open an incident for us to look at/);
    expect(t).toMatch(
      /never published as the vendor’s failure: the review screen refuses to confirm it/,
    );
  });

  it('promises vendors, from the facts, that probing stops within a day of an opt-out request and a written reply follows within three business days', () => {
    const t = text();
    expect(t).toContain(
      `probing stops, and the history is hidden, within ${FACTS.optOutHours} hours of an opt-out request`,
    );
    expect(t).toContain(
      `we reply in writing within ${words(FACTS.vendorReplyBusinessDays)} business days`,
    );
  });

  it('only the failure classes the vendor owns can ever be published (the list the review screen uses)', () => {
    expect([...VENDOR_FAILURE_CLASSES].sort()).toEqual([
      'API_DRIFT',
      'DEPENDENCY_RESOLUTION',
      'DOCS_SNIPPET_ERROR',
      'RUNTIME_VERSION',
    ]);
  });
});
