import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadAllTargets, loadTarget, TargetFileError } from './targets.js';

const yamlFor = (slug: string, extra = '') => `slug: ${slug}
name: ${slug} (test)
docsUrl: https://example.com/docs/${slug}
language: node
level: 2
runtime:
  image: ghcr.io/me/qsr-node:22
  nodeVersion: "22"
extract:
  root: "main"
${extra}`;

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'qsr-targets-'));
  await mkdir(path.join(dir, '_canary'));
  await writeFile(path.join(dir, 'good-one.yaml'), yamlFor('good-one'));
  await writeFile(
    path.join(dir, 'good-two.yaml'),
    yamlFor('good-two', 'placeholders:\n  KEY: dummy\n'),
  );
  await writeFile(path.join(dir, 'wrong-name.yaml'), yamlFor('something-else'));
  await writeFile(
    path.join(dir, 'bad-level.yaml'),
    yamlFor('bad-level').replace('level: 2', 'level: 9'),
  );
  await writeFile(path.join(dir, 'broken.yaml'), 'slug: [unclosed');
  await writeFile(path.join(dir, '_canary', 'canary-pass-node.yaml'), yamlFor('canary-pass-node'));
});

describe('loadTarget', () => {
  it('loads and validates a target, applying schema defaults', async () => {
    const t = await loadTarget(dir, 'good-one');
    expect(t.extract.codeBlocks).toBe('pre code');
    expect(t.expect.timeoutSec).toBe(300);
  });

  it('finds canary targets under _canary/', async () => {
    expect((await loadTarget(dir, 'canary-pass-node')).slug).toBe('canary-pass-node');
  });

  it('rejects a slug that does not match the file name', async () => {
    await expect(loadTarget(dir, 'wrong-name')).rejects.toThrow(/must equal the file name/);
  });

  it('reports schema errors with the field path', async () => {
    await expect(loadTarget(dir, 'bad-level')).rejects.toThrow(/level/);
  });

  it('reports invalid YAML and missing targets as TargetFileError', async () => {
    await expect(loadTarget(dir, 'broken')).rejects.toBeInstanceOf(TargetFileError);
    await expect(loadTarget(dir, 'missing')).rejects.toThrow(/no target "missing"/);
  });
});

describe('loadAllTargets', () => {
  it('excludes canaries by default and includes them on request (invalid files throw)', async () => {
    await expect(loadAllTargets(dir)).rejects.toBeInstanceOf(TargetFileError); // wrong-name, bad-level, broken
    const clean = await mkdtemp(path.join(tmpdir(), 'qsr-clean-'));
    await mkdir(path.join(clean, '_canary'));
    await writeFile(path.join(clean, 'a-tool.yaml'), yamlFor('a-tool'));
    await writeFile(path.join(clean, '_canary', 'canary-x.yaml'), yamlFor('canary-x'));
    expect((await loadAllTargets(clean)).map((t) => t.slug)).toEqual(['a-tool']);
    expect((await loadAllTargets(clean, { canaries: true })).map((t) => t.slug)).toEqual([
      'a-tool',
      'canary-x',
    ]);
  });
});
