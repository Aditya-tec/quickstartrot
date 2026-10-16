import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CANARY_EXPECTATIONS } from '@qsr/core';

// The API judges a cycle's canaries against CANARY_EXPECTATIONS (core). The CLI's canary self-test reads
// targets/_canary/canaries.json. If the two disagree, a healthy runner would produce cycles the API marks
// invalid (or the reverse), so this test pins them together.

interface FileEntry {
  outcome: 'PASS' | 'FAIL';
  failureClass: string | null;
}
const file = JSON.parse(
  readFileSync(resolve(__dirname, '../../../targets/_canary/canaries.json'), 'utf8'),
) as Record<string, FileEntry>;

describe('canaries.json agrees with CANARY_EXPECTATIONS', () => {
  it('has the same slugs', () => {
    expect(Object.keys(file).sort()).toEqual(Object.keys(CANARY_EXPECTATIONS).sort());
  });

  it.each(Object.entries(CANARY_EXPECTATIONS))('%s: same outcome and class', (slug, expected) => {
    const entry = file[slug] as FileEntry;
    expect(entry.outcome).toBe(expected.outcome);
    expect(entry.failureClass).toBe(expected.failureClass ?? null);
  });
});
