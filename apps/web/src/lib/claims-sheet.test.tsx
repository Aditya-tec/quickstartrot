import { readFileSync } from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { numbersIn } from '@qsr/core/public';
import { DetectionPower } from '@/components/detection-power';
import { MethodologyContent } from '@/components/methodology-content';
import { DETECTION } from '@/lib/detection';
import { FACTS } from '@/lib/facts';

// docs/CLAIMS.md lists every figure that could appear in a public post. /methodology is a public page: a number on it that is not in the sheet
// is a number nobody has written a safe wording for. (The README has the same test in packages/cli.)

const sheet = (): string =>
  readFileSync(
    path.resolve(import.meta.dirname, '..', '..', '..', '..', 'docs', 'CLAIMS.md'),
    'utf8',
  );
const pageText = (): string =>
  renderToStaticMarkup(
    <MethodologyContent facts={FACTS} detection={<DetectionPower data={DETECTION} />} />,
  )
    .replaceAll(/<script[\s\S]*?<\/script>/g, ' ')
    .replaceAll(/<[^>]+>/g, ' ')
    .replaceAll('&#x27;', "'")
    .replaceAll(/&[a-z]+;|&#x?\d+;/gi, ' ');

describe('/methodology and docs/CLAIMS.md', () => {
  it('states only numbers that are in the sheet', () => {
    const known = numbersIn(sheet());
    const missing = [...numbersIn(pageText())].filter((n) => !known.has(n));
    expect(
      missing,
      `numbers on /methodology that are not in docs/CLAIMS.md: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('has a row, with its value, for every figure the site quotes about how the pipeline works', () => {
    const rows = new Map<string, string>();
    for (const line of sheet().split('\n')) {
      const m = /^\|\s*`pipeline\.(\w+)`\s*\|(.*)$/.exec(line);
      if (m) rows.set(m[1] ?? '', m[2] ?? '');
    }
    // storageTargetMegabytes is a figure of the deployment notes, not one a page quotes
    const quoted = Object.entries(FACTS).filter(([key]) => key !== 'storageTargetMegabytes');
    expect(quoted.length).toBeGreaterThan(15);
    for (const [key, value] of quoted) {
      expect(rows.has(key), `no pipeline.${key} row in docs/CLAIMS.md`).toBe(true);
      expect(numbersIn(rows.get(key) ?? ''), `pipeline.${key}`).toContain(String(value));
    }
  });

  it('puts the measurement’s own figures in the sheet: the three code-level L2 results, and the L3 sentence', () => {
    const text = sheet();
    expect(text).toMatch(/\| `code\.L2\.v1`/);
    expect(text).toMatch(/\| `code\.L2\.v2`/);
    expect(text).toMatch(/\| `code\.L2\.exportCheck`/);
    expect(text).toContain('experiment, not in production');
    expect(text).toMatch(/\d+ quickstarts? reach(?:es)? L3 in production/);
  });
});
