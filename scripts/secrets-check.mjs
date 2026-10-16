#!/usr/bin/env node
// `pnpm secrets:check`: the local secret gate, run by the pre-commit hook (.husky/pre-commit).
//
// It scans exactly what is staged with gitleaks and exits NON-ZERO on any finding, which makes git
// refuse the commit. It fails closed: if gitleaks cannot run (no binary, no Docker, no git repository)
// it blocks as well, because "could not check" must never look like "checked, clean". The CI gitleaks
// job scans the whole history as a second line of defence; `git commit --no-verify` is the only way
// around this gate and it is deliberate.
//
// Exit codes: 0 clean (or nothing staged), 1 secrets found, 2 the scan could not run.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const GITLEAKS_IMAGE = 'zricethezav/gitleaks:v8.30.1';

/** gitleaks arguments for a scan of the staged changes of the repository at `source`. */
export const gitleaksArgs = (source, config) => [
  'git',
  '--staged',
  '--redact',
  '--no-banner',
  '--exit-code',
  '1',
  '-c',
  config,
  source,
];

/** A local binary wins (fast, no daemon); Docker is the fallback; null means nothing can scan. */
export const pickRunner = ({ local, docker }) => (local ? 'local' : docker ? 'docker' : null);

const run = (cmd, args, options = {}) =>
  spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });

function main() {
  const top = run('git', ['rev-parse', '--show-toplevel']);
  if (top.status !== 0) {
    console.error(
      'secrets:check: not inside a git repository, so there is nothing staged to scan (blocked).',
    );
    return 2;
  }
  const root = path.resolve(top.stdout.trim());
  const configFile = path.join(root, '.gitleaks.toml');
  const hasConfig = existsSync(configFile);

  const runner = pickRunner({
    local: run('gitleaks', ['version']).status === 0,
    docker: run('docker', ['info']).status === 0,
  });
  if (runner === null) {
    console.error(
      [
        'secrets:check: the staged changes were NOT checked: gitleaks cannot run here.',
        'Install gitleaks (https://github.com/gitleaks/gitleaks) or start Docker, then commit again.',
        'The commit is blocked rather than left unchecked.',
      ].join('\n'),
    );
    return 2;
  }

  const result =
    runner === 'local'
      ? run('gitleaks', gitleaksArgs(root, hasConfig ? configFile : ''), { cwd: root })
      : run('docker', [
          'run',
          '--rm',
          '-v',
          `${root}:/repo`,
          '-w',
          '/repo',
          '-e',
          'GIT_CONFIG_COUNT=1',
          '-e',
          'GIT_CONFIG_KEY_0=safe.directory',
          '-e',
          'GIT_CONFIG_VALUE_0=/repo',
          GITLEAKS_IMAGE,
          ...gitleaksArgs('/repo', hasConfig ? '/repo/.gitleaks.toml' : ''),
        ]);

  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  if (result.status === 0) {
    console.log('secrets:check: no secrets in the staged changes.');
    return 0;
  }
  if (result.status === 1) {
    console.error(
      'secrets:check: BLOCKED. gitleaks found what looks like a secret in the staged changes (values redacted above).\n' +
        'Remove it from the commit. If it is a documented placeholder, allowlist exactly that value in .gitleaks.toml.',
    );
    return 1;
  }
  console.error(
    `secrets:check: the scan could not run (${runner} exited with ${result.status}). The staged changes were NOT checked; commit blocked.`,
  );
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
