import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS } from './docker.js';
import { buildRunArgs, scrubbedEnv } from './docker-cli.js';

describe('buildRunArgs: the sandbox flags from spec section 9', () => {
  const args = buildRunArgs({
    name: 'qsr-abc',
    image: 'ghcr.io/aditya-tec/qsr-node@sha256:' + 'a'.repeat(64),
    limits: DEFAULT_LIMITS,
    labels: { 'qsr.run-id': 'abc' },
  });

  it('is exactly `docker run -d --name … --user 1001:1001 --memory 2g --cpus 2 --pids-limit 512 --cap-drop ALL --security-opt no-new-privileges -w /work <image> sleep infinity`', () => {
    expect(args).toEqual([
      'run',
      '-d',
      '--name',
      'qsr-abc',
      '--user',
      '1001:1001',
      '--memory',
      '2g',
      '--cpus',
      '2',
      '--pids-limit',
      '512',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '-w',
      '/work',
      '--label',
      'qsr.run-id=abc',
      'ghcr.io/aditya-tec/qsr-node@sha256:' + 'a'.repeat(64),
      'sleep',
      'infinity',
    ]);
  });

  it('passes no environment, no volumes, no privileged mode and no host networking or devices', () => {
    for (const forbidden of [
      '-e',
      '--env',
      '--env-file',
      '-v',
      '--volume',
      '--mount',
      '--privileged',
      '--network',
      '--net',
      '--device',
      '--cap-add',
      '--pid',
      '--ipc',
      '--userns',
    ]) {
      expect(args, forbidden).not.toContain(forbidden);
    }
  });

  it('uses the limits it is given', () => {
    const tight = buildRunArgs({
      name: 'n',
      image: 'i',
      limits: { memory: '128m', cpus: '1', pidsLimit: 64 },
      labels: {},
    });
    expect(tight.slice(tight.indexOf('--memory'), tight.indexOf('--memory') + 2)).toEqual([
      '--memory',
      '128m',
    ]);
    expect(tight[tight.indexOf('--pids-limit') + 1]).toBe('64');
    expect(tight).not.toContain('--label');
  });
});

describe('scrubbedEnv: the docker CLI never inherits the host environment wholesale', () => {
  it('keeps only what the docker client needs to find and talk to the daemon', () => {
    const env = scrubbedEnv({
      PATH: '/usr/bin',
      HOME: '/home/me',
      DOCKER_HOST: 'tcp://daemon:2375',
      GROQ_API_KEY: 'gsk_secret',
      SUPABASE_SERVICE_ROLE_KEY: 'eyJ.secret',
      INGEST_HMAC_SECRET: 'deadbeef',
      ADMIN_TOKEN: 'tok',
      DATABASE_URL: 'postgres://u:p@h/db',
      GITHUB_TOKEN: 'ghp_x',
    });
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/home/me', DOCKER_HOST: 'tcp://daemon:2375' });
  });

  it('keeps the Windows variables Docker Desktop needs, and drops undefined values', () => {
    const env = scrubbedEnv({
      Path: 'C:\\x',
      SystemRoot: 'C:\\Windows',
      USERPROFILE: 'C:\\Users\\me',
      DOCKER_CONFIG: undefined,
      FOO: 'bar',
    });
    expect(env).toEqual({ Path: 'C:\\x', SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\Users\\me' });
  });
});
