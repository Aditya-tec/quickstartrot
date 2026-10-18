import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// The API runs on a free tier that sleeps and takes up to a minute to wake. A page that waited for it would leave a visitor looking at a
// blank screen, so no public page, layout or component may read its address. Public pages read the public database views (cached for
// minutes). Only the places below may: the /submit form's route, the warm-up, the admin area, and the helpers they use. A new file that
// reads the address fails here, so adding one is a decision and not an accident.

const SRC = path.resolve(import.meta.dirname, '..');
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return files(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });

const MAY_READ_THE_API_ADDRESS = [
  /^lib\/env(\.test)?\.ts$/,
  /^lib\/submit(\.test)?\.ts$/,
  /^lib\/warm(\.test)?\.ts$/,
  /^lib\/admin-api(\.test)?\.ts$/,
  /^lib\/no-api-at-render\.test\.ts$/,
  /^app\/api\/submit\//,
  /^app\/api\/warm\//,
  /^app\/admin\//,
];

describe('public pages do not wait for the API', () => {
  const readers = files(SRC)
    .map((f) => path.relative(SRC, f).split(path.sep).join('/'))
    .filter((rel) => /apiBaseUrl|API_BASE_URL/.test(readFileSync(path.join(SRC, rel), 'utf8')));

  it('only the submit route, the warm-up, the admin area and their helpers read the API address', () => {
    const stray = readers.filter((rel) => !MAY_READ_THE_API_ADDRESS.some((re) => re.test(rel)));
    expect(stray, `these files read the API address: ${stray.join(', ')}`).toEqual([]);
  });

  it('finds the readers it expects (so the scan itself works)', () => {
    expect(readers).toContain('app/api/submit/route.ts');
    expect(readers).toContain('app/api/warm/route.ts');
    expect(readers).toContain('lib/env.ts');
  });

  it('no page, layout, public component or loader of the public data is among them', () => {
    for (const rel of readers) {
      expect(rel).not.toMatch(/^app\/(?!admin\/|api\/)/); // app/page.tsx, app/tools/.., app/methodology/.. and so on
      expect(rel).not.toMatch(/^components\/(?!admin\/)/);
      expect(rel).not.toMatch(/^lib\/(service|cached|data\/)/);
    }
  });
});
