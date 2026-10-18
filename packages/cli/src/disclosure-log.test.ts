import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// docs/disclosure-log.md is a record, kept by hand, of every private heads-up sent to a vendor. Disclosure tracking in the admin page is not
// built, so the launch check (scripts/launch-check.mjs) reads this file. It is empty on purpose, and says so.

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), 'utf8');
const md = read('docs/disclosure-log.md');

describe('docs/disclosure-log.md', () => {
  it('is empty on purpose and says so: a table header and a note that none have been sent', () => {
    expect(md).toMatch(/^None have been sent\.$/m);
    expect(md).toMatch(/It is empty on purpose/);
    const header = md.split('\n').find((l) => l.startsWith('| Vendor'));
    expect(header).toBeDefined();
    const columns = (header ?? '')
      .split('|')
      .map((c) => c.trim())
      .filter(Boolean);
    expect(columns).toEqual([
      'Vendor',
      'Tool (slug)',
      'Failure class',
      'Sent to (channel)',
      'Date sent (UTC)',
      'Status',
      'Reply',
      'Notes',
    ]);
  });

  it('has no row below the header (an example row lives in a comment, which the check ignores)', () => {
    const withoutComments = md.replaceAll(/<!--[\s\S]*?-->/g, '');
    const rows = withoutComments.split('\n').filter((l) => l.startsWith('|'));
    expect(rows).toHaveLength(2); // the header and its separator
    expect(rows[1]).toMatch(/^\|[\s|:-]+\|$/);
  });

  it('documents the statuses the launch check accepts, and never an address', () => {
    for (const status of ['sent', 'replied', 'fixed', 'disputed', 'no reply', 'withdrawn'])
      expect(md).toContain(`\`${status}\``);
    expect(md).toMatch(/never the address itself/);
    expect(md).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
  });

  it('tells whoever adds the first row to change the note, and says what reads the file', () => {
    expect(md).toContain('Some have been sent.');
    expect(md).toContain('scripts/launch-check.mjs');
    expect(md).toContain('(DISCLOSURE.md)');
  });

  it('is the record the disclosure policy points at, and the policy says the launch check reads it', () => {
    const policy = read('docs/DISCLOSURE.md');
    expect(policy).toContain('disclosure-log.md');
    expect(policy).not.toMatch(/asks for the record by hand/);
    expect(policy).toMatch(/launch check reads it/i);
  });
});
