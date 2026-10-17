import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// `@qsr/core/public` is what the website's client components import. A browser bundle cannot contain a Node
// built-in (`node:crypto` in the HMAC code, for example), so every module reachable from the entry must be free
// of them. This walks the import graph from the source of the entry and fails on the first offender.

const SRC = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(SRC, '..');

function importsOf(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  return [...text.matchAll(/(?:from|import)\s+['"]([^'"]+)['"]/g)].map((m) => m[1] as string);
}

function walk(entry: string): { file: string; spec: string }[] {
  const seen = new Set<string>();
  const found: { file: string; spec: string }[] = [];
  const visit = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const spec of importsOf(file)) {
      found.push({ file: path.relative(SRC, file), spec });
      if (spec.startsWith('.')) {
        const target = path.resolve(path.dirname(file), spec.replace(/\.js$/, '.ts'));
        if (existsSync(target)) visit(target);
      }
    }
  };
  visit(entry);
  return found;
}

describe('@qsr/core/public', () => {
  it('is exported by the package, next to the main entry', () => {
    const pkg = JSON.parse(readFileSync(path.join(PKG, 'package.json'), 'utf8')) as {
      exports: Record<string, { default: string; types: string }>;
    };
    expect(pkg.exports['./public']).toEqual({
      types: './dist/public.d.ts',
      default: './dist/public.js',
    });
  });

  it('has an entry that exports the public data model, the URL validator and the submission schema', async () => {
    const mod = await import('./public.js');
    for (const name of [
      'PublicToolRow',
      'publicStatus',
      'computeHeadline',
      'sanitizeRun',
      'confirmedOnly',
      'validateSubmissionUrl',
      'SubmissionBody',
    ])
      expect(mod, name).toHaveProperty(name);
  }, 30_000); // a cold import of the whole graph; under a loaded machine it can pass 5 s

  it('reaches no Node built-in, anywhere in its import graph', () => {
    const graph = walk(path.join(SRC, 'public.ts'));
    expect(graph.length).toBeGreaterThan(5);
    const offenders = graph.filter(
      ({ spec }) =>
        spec.startsWith('node:') ||
        ['fs', 'path', 'crypto', 'os', 'child_process', 'zlib'].includes(spec),
    );
    expect(offenders).toEqual([]);
  });

  it('does not reach the HMAC, hashing or path modules', () => {
    const files = new Set(walk(path.join(SRC, 'public.ts')).map((g) => g.file));
    for (const banned of ['hmac.ts', 'canonical.ts', 'content-hash.ts', 'work-path.ts'])
      expect(
        [...files].some((f) => f.endsWith(banned)),
        banned,
      ).toBe(false);
  });
});
