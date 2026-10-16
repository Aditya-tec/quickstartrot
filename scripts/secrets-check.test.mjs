import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { gitleaksArgs, pickRunner } from './secrets-check.mjs';

// `pnpm secrets:check` is the pre-commit gate. These tests prove it BLOCKS: they build a real git
// repository, stage a secret and run the script exactly as the hook does. The fake token is assembled
// at runtime so no scanner mistakes this file for a leak.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'secrets-check.mjs');
const CONFIG = path.join(HERE, '..', '.gitleaks.toml');

const has = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8' }).status === 0;
const canScan = has('gitleaks', ['version']) || has('docker', ['info']);
const required = process.env.QSR_REQUIRE_DOCKER === '1';
const skip = !canScan && !required ? 'neither gitleaks nor Docker is available' : false;

/** A GitHub-token-shaped value with real-looking entropy, built from parts. */
const fakeToken = () => ['ghp', '_', 'q7Zk2LmN9xVb4TrP8cHd1WsYe5GaJf3UoXiB'].join('');

function repo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'qsr-secrets-'));
  const git = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  copyFileSync(CONFIG, path.join(dir, '.gitleaks.toml'));
  return { dir, git };
}
const check = (dir, env = process.env) =>
  spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: 'utf8', env, timeout: 240_000 });

describe('gate plumbing (no scanner needed)', () => {
  it('prefers a local gitleaks binary over Docker', () => {
    assert.equal(pickRunner({ local: true, docker: true }), 'local');
    assert.equal(pickRunner({ local: false, docker: true }), 'docker');
    assert.equal(pickRunner({ local: false, docker: false }), null);
  });

  it('scans only the staged changes, redacts findings, and uses the repository config', () => {
    const args = gitleaksArgs('/work/repo', '/work/repo/.gitleaks.toml');
    assert.deepEqual(args.slice(0, 2), ['git', '--staged']);
    assert.ok(args.includes('--redact'));
    assert.ok(args.includes('--exit-code'));
    assert.equal(args[args.indexOf('--exit-code') + 1], '1');
    assert.equal(args[args.indexOf('-c') + 1], '/work/repo/.gitleaks.toml');
    assert.equal(args.at(-1), '/work/repo');
  });
});

describe('the gate blocks', { skip }, () => {
  it('exits non-zero when a staged file contains a secret, and says so without printing it', () => {
    const { dir, git } = repo();
    writeFileSync(path.join(dir, 'config.js'), `export const token = "${fakeToken()}";\n`);
    git('add', 'config.js');
    const r = check(dir);
    assert.notEqual(r.status, 0, `expected a block, got exit ${r.status}\n${r.stdout}${r.stderr}`);
    assert.match(`${r.stdout}${r.stderr}`, /BLOCKED/);
    assert.ok(!`${r.stdout}${r.stderr}`.includes(fakeToken()), 'the secret must not be echoed');
  });

  it('a real `git commit` is refused when the hook runs the gate', () => {
    const { dir, git } = repo();
    mkdirSync(path.join(dir, '.git', 'hooks'), { recursive: true });
    const hook = path.join(dir, '.git', 'hooks', 'pre-commit');
    writeFileSync(
      hook,
      `#!/bin/sh\nexec "${process.execPath.replaceAll('\\', '/')}" "${SCRIPT.replaceAll('\\', '/')}"\n`,
      {
        mode: 0o755,
      },
    );
    writeFileSync(path.join(dir, 'leak.txt'), `${fakeToken()}\n`);
    git('add', 'leak.txt');
    const commit = git('commit', '-m', 'add a secret');
    assert.notEqual(commit.status, 0, `the commit went through:\n${commit.stdout}${commit.stderr}`);
    assert.equal(git('rev-list', '--all', '--count').stdout.trim(), '0', 'no commit may exist');
  });

  it('exits 0 for a clean staged change', () => {
    const { dir, git } = repo();
    writeFileSync(path.join(dir, 'a.js'), 'export const answer = 42;\n');
    git('add', 'a.js');
    assert.equal(check(dir).status, 0);
  });

  it('exits 0 when nothing is staged', () => {
    const { dir } = repo();
    assert.equal(check(dir).status, 0);
  });

  it('only looks at what is staged: an unstaged secret does not block, a staged one does', () => {
    const { dir, git } = repo();
    writeFileSync(path.join(dir, 'clean.js'), 'export const a = 1;\n');
    writeFileSync(path.join(dir, 'leak.js'), `export const t = "${fakeToken()}";\n`);
    git('add', 'clean.js');
    assert.equal(check(dir).status, 0);
    git('add', 'leak.js');
    assert.notEqual(check(dir).status, 0);
    git('rm', '-q', '--cached', 'leak.js');
    assert.equal(check(dir).status, 0);
  });

  it('honours the repository allowlist (.gitleaks.toml) for the documented placeholders', () => {
    const { dir, git } = repo();
    writeFileSync(path.join(dir, 'doc.md'), 'RESEND_API_KEY=re_123456789\n');
    git('add', 'doc.md');
    assert.equal(check(dir).status, 0);
  });
});

describe('the gate fails closed', () => {
  /** A PATH holding nothing but a shim for git: no gitleaks, no Docker. */
  function pathWithOnlyGit() {
    const finder = process.platform === 'win32' ? 'where' : 'which';
    const found = spawnSync(finder, ['git'], { encoding: 'utf8' }).stdout;
    const real = found.split(/\r?\n/)[0].trim();
    // Node cannot spawn a .cmd shim without a shell, so on Windows use git's own directory, which
    // holds neither gitleaks nor Docker.
    if (process.platform === 'win32') return path.dirname(real);
    const bin = mkdtempSync(path.join(tmpdir(), 'qsr-bin-'));
    writeFileSync(path.join(bin, 'git'), '#!/bin/sh\nexec "' + real + '" "$@"\n', { mode: 0o755 });
    return bin;
  }

  it('with neither gitleaks nor Docker it blocks (exit 2) instead of silently passing', () => {
    const { dir, git } = repo();
    writeFileSync(path.join(dir, 'a.js'), 'export const a = 1;\n');
    git('add', 'a.js');
    const bin = pathWithOnlyGit();
    const r = check(dir, { ...process.env, PATH: bin, Path: bin });
    assert.equal(r.status, 2, `${r.stdout}${r.stderr}`);
    assert.match(`${r.stdout}${r.stderr}`, /NOT checked/);
  });

  it('outside a git repository it refuses to run', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'qsr-nogit-'));
    const r = check(dir);
    assert.equal(r.status, 2);
    assert.match(`${r.stdout}${r.stderr}`, /not inside a git repository/);
  });
});
