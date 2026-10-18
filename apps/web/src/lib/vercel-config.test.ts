import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// apps/web/vercel.json has an "ignored build step": exit code 0 means Vercel skips the build. It used to compare only the newest commit
// with its parent, so a push of several commits whose LAST one touched only docs deployed nothing, however much the earlier ones changed
// (this is how the P10a launch kit was left undeployed). It now compares with the last commit that was deployed. These tests run the real
// command in a scratch repository.

const config = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, '..', '..', 'vercel.json'), 'utf8'),
) as { ignoreCommand: string };

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]): string => {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.test', ...args], {
    cwd,
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

/** A repository laid out like ours, with a first commit, and a helper that adds a commit touching one file. */
function scratch() {
  const root = mkdtempSync(path.join(tmpdir(), 'qsr-vercel-'));
  dirs.push(root);
  for (const d of ['apps/web', 'packages/core', 'docs'])
    mkdirSync(path.join(root, d), { recursive: true });
  for (const f of [
    'pnpm-lock.yaml',
    'package.json',
    'pnpm-workspace.yaml',
    'turbo.json',
    'tsconfig.base.json',
  ])
    writeFileSync(path.join(root, f), 'x\n');
  git(root, 'init', '-q');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'first');
  let n = 0;
  const commit = (file: string): string => {
    n += 1;
    writeFileSync(path.join(root, file), `change ${n}\n`);
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', `c${n}`);
    return git(root, 'rev-parse', 'HEAD');
  };
  /** Runs the ignored build step the way Vercel does, from apps/web; returns its exit code (0 = skip the build, 1 = build). */
  const run = (previous?: string): number => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env['VERCEL_GIT_PREVIOUS_SHA'];
    if (previous !== undefined) env['VERCEL_GIT_PREVIOUS_SHA'] = previous;
    return (
      spawnSync('sh', ['-c', config.ignoreCommand], {
        cwd: path.join(root, 'apps', 'web'),
        env,
        encoding: 'utf8',
      }).status ?? -1
    );
  };
  return { root, commit, run, head: () => git(root, 'rev-parse', 'HEAD') };
}

describe('the ignored build step of apps/web', () => {
  it('builds when the last deployed commit is older than a push whose newest commit only changed docs', () => {
    const r = scratch();
    const deployed = r.head();
    r.commit('apps/web/page.tsx'); // a web change ...
    r.commit('docs/readme-note.md'); // ... followed by a commit that only touches docs, in the same push
    expect(r.run(deployed)).toBe(1);
  });

  it('skips when nothing it watches changed since the last deployed commit, however many commits there were', () => {
    const r = scratch();
    const deployed = r.head();
    r.commit('docs/a.md');
    r.commit('docs/b.md');
    expect(r.run(deployed)).toBe(0);
  });

  it('builds for a change in packages/core or in the lockfile', () => {
    for (const file of ['packages/core/x.ts', 'pnpm-lock.yaml', 'package.json']) {
      const r = scratch();
      const deployed = r.head();
      r.commit(file);
      r.commit('docs/after.md');
      expect(r.run(deployed), file).toBe(1);
    }
  });

  it('without a previous deployment it compares with the parent commit, as before', () => {
    const web = scratch();
    web.commit('apps/web/page.tsx');
    expect(web.run()).toBe(1);
    const docs = scratch();
    docs.commit('docs/a.md');
    expect(docs.run()).toBe(0);
  });

  it('builds, rather than skips, when the previous deployed commit is not in the clone', () => {
    const r = scratch();
    r.commit('docs/a.md');
    expect(r.run('0123456789abcdef0123456789abcdef01234567')).toBe(1);
  });

  it('keeps watching the same places as before', () => {
    for (const watched of [
      '.',
      '../../packages/core',
      '../../pnpm-lock.yaml',
      '../../package.json',
      '../../pnpm-workspace.yaml',
      '../../turbo.json',
      '../../tsconfig.base.json',
    ])
      expect(config.ignoreCommand, watched).toContain(watched);
  });
});
