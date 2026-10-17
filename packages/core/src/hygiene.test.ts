import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Source-hygiene guard. Zero-width and bidirectional-control characters are invisible in review and
// are the basis of "Trojan Source" attacks. They must never appear in committed source, tests,
// targets, workflows or fixtures. Ranges are written as code points (never as the characters
// themselves) so this file is clean, and so a tool that rewrites backslash-u escape sequences into
// literal characters is caught here instead of silently shipping invisible text.

const FORBIDDEN_RANGES: readonly (readonly [number, number])[] = [
  [0x200b, 0x200d], // zero width space / non-joiner / joiner
  [0x2060, 0x2060], // word joiner
  [0xfeff, 0xfeff], // zero width no-break space (BOM)
  [0x202a, 0x202e], // bidi embeddings and overrides
  [0x2066, 0x2069], // bidi isolates
];

/**
 * Explicit allowlist of repo-relative paths (forward slashes) that intentionally contain forbidden
 * characters, for example a fixture page that tests how the crawler handles them. Keep it empty
 * unless there is a written reason next to the entry.
 */
const ALLOWLIST: readonly string[] = [];

export interface Finding {
  file: string;
  line: number;
  column: number;
  codePoint: string;
}

const isForbidden = (cp: number): boolean =>
  FORBIDDEN_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi);

export function findHiddenCharacters(text: string): Omit<Finding, 'file'>[] {
  const found: Omit<Finding, 'file'>[] = [];
  const lines = text.split('\n');
  lines.forEach((content, i) => {
    let column = 0;
    for (const ch of content) {
      column++;
      const cp = ch.codePointAt(0) ?? 0;
      if (isForbidden(cp)) {
        found.push({
          line: i + 1,
          column,
          codePoint: `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`,
        });
      }
    }
  });
  return found;
}

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  '.next',
  '.turbo',
  '.git',
  'coverage',
  '.qsr-cache',
  '.qsr-runs', // local scratch of scripts/batch-run.mjs and friends (git-ignored)
  '.probe-local',
]);
const TEXT_EXT = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '.cjs',
  '.json',
  '.yaml',
  '.yml',
  '.md',
  '.html',
  '.css',
  '.sql',
  '.snap',
  '.txt',
  '.sh',
]);

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* walk(path.join(dir, entry.name));
    } else if (TEXT_EXT.has(path.extname(entry.name))) {
      yield path.join(dir, entry.name);
    }
  }
}

export function scan(
  roots: readonly string[],
  base: string,
  allowlist: readonly string[] = ALLOWLIST,
): Finding[] {
  const findings: Finding[] = [];
  for (const root of roots) {
    const abs = path.join(base, root);
    try {
      readdirSync(abs);
    } catch {
      continue; // root does not exist in this checkout
    }
    for (const file of walk(abs)) {
      const rel = path.relative(base, file).split(path.sep).join('/');
      if (allowlist.includes(rel)) continue;
      for (const f of findHiddenCharacters(readFileSync(file, 'utf8')))
        findings.push({ file: rel, ...f });
    }
  }
  return findings;
}

const REPO = fileURLToPath(new URL('../../../', import.meta.url));

/** Everything that can carry code or config into the build. docs/ is excluded: it holds raw spec text. */
const packageDirs = (parent: string): string[] =>
  readdirSync(path.join(REPO, parent), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => `${parent}/${e.name}`);

const ROOTS = [
  ...packageDirs('packages'),
  ...packageDirs('apps'),
  'scripts',
  'targets',
  'fixtures',
  'docker',
  '.github',
];

describe('source hygiene', () => {
  it('no zero-width or bidi control characters in sources, tests, targets, workflows or fixtures', () => {
    const findings = scan(ROOTS, REPO);
    const report = findings.map((f) => `${f.file}:${f.line}:${f.column} ${f.codePoint}`);
    expect(report).toEqual([]);
    // The walk covers every package directory, so under a parallel monorepo run it can take a few seconds.
  }, 30_000);

  it('the guard catches every forbidden range (self-test)', () => {
    for (const [lo, hi] of FORBIDDEN_RANGES) {
      for (const cp of [lo, hi]) {
        const text = `const a = 'x${String.fromCodePoint(cp)}y';`;
        expect(findHiddenCharacters(text)).toEqual([
          { line: 1, column: 13, codePoint: `U+${cp.toString(16).toUpperCase().padStart(4, '0')}` },
        ]);
      }
    }
  });

  it('does not flag ordinary text, including accents, emoji and similar-looking dashes', () => {
    expect(findHiddenCharacters('café – naïve — 日本語 😀 ¶ §\n\tindented')).toEqual([]);
  });

  it('reports line and column across lines', () => {
    const text = `ok\nsecond${String.fromCodePoint(0x202e)} line`;
    expect(findHiddenCharacters(text)).toEqual([{ line: 2, column: 7, codePoint: 'U+202E' }]);
  });

  it('finds a planted character in a scanned file and honours the explicit allowlist', () => {
    const base = mkdtempSync(path.join(tmpdir(), 'qsr-hygiene-'));
    mkdirSync(path.join(base, 'packages', 'x', 'src'), { recursive: true });
    mkdirSync(path.join(base, 'fixtures'), { recursive: true });
    mkdirSync(path.join(base, 'packages', 'x', 'node_modules'), { recursive: true });
    writeFileSync(
      path.join(base, 'packages', 'x', 'src', 'bad.ts'),
      `const s = 'a${String.fromCodePoint(0x200b)}b';\n`,
    );
    writeFileSync(
      path.join(base, 'fixtures', 'intentional.html'),
      `<p>${String.fromCodePoint(0xfeff)}</p>`,
    );
    writeFileSync(
      path.join(base, 'packages', 'x', 'node_modules', 'skip.js'),
      String.fromCodePoint(0x200b),
    );
    writeFileSync(path.join(base, 'packages', 'x', 'src', 'clean.ts'), 'export const ok = 1;\n');

    const roots = ['packages/x', 'fixtures', 'does-not-exist'];
    expect(scan(roots, base, []).map((f) => `${f.file}:${f.line}:${f.codePoint}`)).toEqual([
      'packages/x/src/bad.ts:1:U+200B',
      'fixtures/intentional.html:1:U+FEFF',
    ]);
    expect(scan(roots, base, ['fixtures/intentional.html']).map((f) => f.file)).toEqual([
      'packages/x/src/bad.ts',
    ]);
  });
});
