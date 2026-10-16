import { spawn } from 'node:child_process';
import type { ContainerSpec, DockerClient, ExecOptions, ExecOutcome, ImageInfo } from './docker.js';

// The real DockerClient: shells out to the `docker` binary. The executor never talks to the network
// itself; the daemon does, on its behalf, and the containers it starts get no environment at all.

/**
 * The only host variables the docker CLI is given: enough to find the binary, the user's Docker
 * config and the daemon. Everything else (GROQ_API_KEY, SUPABASE_*, INGEST_HMAC_SECRET, tokens,
 * database URLs, ...) is dropped, so it cannot leak through the CLI even by accident.
 */
const ENV_ALLOWLIST = new Set([
  'PATH',
  'Path',
  'PATHEXT',
  'SystemRoot',
  'SYSTEMROOT',
  'windir',
  'ComSpec',
  'COMSPEC',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramData',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'ProgramW6432',
  'TEMP',
  'TMP',
  'TMPDIR',
  'USER',
  'USERNAME',
  'LANG',
  'LC_ALL',
  'XDG_RUNTIME_DIR',
  'XDG_CONFIG_HOME',
  'DOCKER_HOST',
  'DOCKER_CONFIG',
  'DOCKER_CONTEXT',
  'DOCKER_TLS_VERIFY',
  'DOCKER_CERT_PATH',
  'DOCKER_API_VERSION',
]);

export function scrubbedEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && ENV_ALLOWLIST.has(key)) env[key] = value;
  }
  return env;
}

/** Spec section 9, container lifecycle, step 1. Deliberately has no `-e`, `-v`, `--network` or `--privileged`. */
export function buildRunArgs(spec: ContainerSpec): string[] {
  const { memory, cpus, pidsLimit } = spec.limits;
  return [
    'run',
    '-d',
    '--name',
    spec.name,
    '--user',
    '1001:1001',
    '--memory',
    memory,
    '--cpus',
    cpus,
    '--pids-limit',
    String(pidsLimit),
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '-w',
    '/work',
    ...Object.entries(spec.labels).flatMap(([k, v]) => ['--label', `${k}=${v}`]),
    spec.image,
    'sleep',
    'infinity',
  ];
}

export interface DockerCliOptions {
  bin?: string;
  /** Source of the allowlisted variables; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

interface Captured {
  code: number | null;
  stdout: string;
  stderr: string;
}

export function createDockerCli(options: DockerCliOptions = {}): DockerClient {
  const bin = options.bin ?? 'docker';
  const env = scrubbedEnv(options.env ?? process.env);

  /** Runs a short docker command and collects its output (bounded). */
  const capture = (args: string[]): Promise<Captured> =>
    new Promise((resolve, reject) => {
      const child = spawn(bin, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c: Buffer) => {
        if (stdout.length < 1 << 20) stdout += c.toString('utf8');
      });
      child.stderr.on('data', (c: Buffer) => {
        if (stderr.length < 1 << 20) stderr += c.toString('utf8');
      });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });

  const must = async (args: string[], what: string): Promise<string> => {
    const r = await capture(args);
    if (r.code !== 0) throw new Error(`${what} failed (exit ${r.code}): ${r.stderr.trim()}`);
    return r.stdout;
  };

  return {
    async inspectImage(image: string): Promise<ImageInfo | null> {
      const r = await capture([
        'image',
        'inspect',
        '--format',
        '{{.Id}} {{json .RepoDigests}}',
        image,
      ]);
      if (r.code !== 0) return null;
      const line = r.stdout.trim();
      const space = line.indexOf(' ');
      const repoDigests = JSON.parse(line.slice(space + 1)) as string[] | null;
      return { id: line.slice(0, space), repoDigests: repoDigests ?? [] };
    },

    async pullImage(image: string): Promise<void> {
      await must(['pull', '--quiet', image], `docker pull ${image}`);
    },

    async start(spec: ContainerSpec): Promise<void> {
      await must(buildRunArgs(spec), `docker run ${spec.name}`);
    },

    exec(name: string, argv: readonly string[], o: ExecOptions): Promise<ExecOutcome> {
      return new Promise((resolve, reject) => {
        const hasStdin = o.stdin !== undefined;
        const child = spawn(bin, ['exec', ...(hasStdin ? ['-i'] : []), name, ...argv], {
          env,
          stdio: [hasStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });
        let timedOut = false;
        child.stdout?.on('data', (c: Buffer) => o.onStdout(c));
        child.stderr?.on('data', (c: Buffer) => o.onStderr(c));
        if (hasStdin) {
          child.stdin?.on('error', () => undefined); // the process may exit before reading everything
          child.stdin?.end(o.stdin);
        }
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, o.timeoutMs);
        const onAbort = (): void => void child.kill('SIGKILL');
        o.signal?.addEventListener('abort', onAbort, { once: true });
        child.on('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
        child.on('close', (code, signal) => {
          clearTimeout(timer);
          o.signal?.removeEventListener('abort', onAbort);
          resolve({ exitCode: signal === null && !timedOut ? code : null, timedOut });
        });
      });
    },

    async remove(name: string): Promise<void> {
      const r = await capture(['rm', '-f', name]);
      if (r.code !== 0 && !/No such container/i.test(r.stderr)) {
        throw new Error(`docker rm -f ${name} failed (exit ${r.code}): ${r.stderr.trim()}`);
      }
    },

    async serverVersion(): Promise<string> {
      const r = await capture(['version', '--format', '{{.Server.Version}}']);
      return r.code === 0 ? r.stdout.trim() : 'unknown';
    },
  };
}
