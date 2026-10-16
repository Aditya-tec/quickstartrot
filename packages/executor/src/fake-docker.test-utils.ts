import type { ContainerSpec, DockerClient, ExecOptions, ExecOutcome, ImageInfo } from './docker.js';

/** What a scripted exec produces. Throwing simulates a crash of the executor's own plumbing. */
export interface FakeExec {
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  timedOut?: boolean;
  throws?: Error;
}

export interface ExecCall {
  name: string;
  argv: readonly string[];
  stdin: string | undefined;
  options: ExecOptions;
  /** The shell script (argv[2]) for `bash -c/-lc`, and the user command for step execs. */
  script: string;
  command: string | undefined;
  kind: 'step' | 'check' | 'write' | 'env' | 'capture-env' | 'capture-resolved' | 'setup' | 'other';
}

type Handler = (call: ExecCall) => FakeExec | undefined;

/** An in-memory DockerClient that records everything and answers from a handler. */
export class FakeDocker implements DockerClient {
  readonly calls: ExecCall[] = [];
  readonly started: ContainerSpec[] = [];
  readonly removed: string[] = [];
  readonly pulled: string[] = [];
  image: ImageInfo | null = { id: `sha256:${'1'.repeat(64)}`, repoDigests: [] };
  startError: Error | undefined;
  removeError: Error | undefined;
  version = '29.0.0-fake';

  constructor(private readonly handler: Handler = () => undefined) {}

  async inspectImage(): Promise<ImageInfo | null> {
    return this.image;
  }

  async pullImage(image: string): Promise<void> {
    this.pulled.push(image);
    this.image ??= {
      id: `sha256:${'2'.repeat(64)}`,
      repoDigests: [`${image.split(':')[0]}@sha256:${'a'.repeat(64)}`],
    };
  }

  async start(spec: ContainerSpec): Promise<void> {
    this.started.push(spec);
    if (this.startError) throw this.startError;
  }

  async exec(name: string, argv: readonly string[], options: ExecOptions): Promise<ExecOutcome> {
    const script = argv[2] ?? '';
    const call: ExecCall = {
      name,
      argv,
      stdin: options.stdin,
      options,
      script,
      command:
        script.includes('exec timeout') && !script.includes('qsr-harness-check')
          ? argv[5]
          : undefined,
      kind: classify(argv),
    };
    this.calls.push(call);
    const r = this.handler(call) ?? {};
    if (r.throws) throw r.throws;
    if (r.stdout) options.onStdout(Buffer.from(r.stdout));
    if (r.stderr) options.onStderr(Buffer.from(r.stderr));
    return { exitCode: r.exitCode === undefined ? 0 : r.exitCode, timedOut: r.timedOut ?? false };
  }

  async remove(name: string): Promise<void> {
    this.removed.push(name);
    if (this.removeError) throw this.removeError;
  }

  async serverVersion(): Promise<string> {
    return this.version;
  }

  /** Commands of the plan's shell/run steps, in the order they were executed. */
  get stepCommands(): string[] {
    return this.calls.filter((c) => c.kind === 'step').map((c) => c.command ?? '');
  }
}

function classify(argv: readonly string[]): ExecCall['kind'] {
  const script = argv[2] ?? '';
  if (script.includes('qsr-harness-check')) return 'check';
  if (script.includes('exec timeout')) return 'step';
  if (script.includes('realpath -m')) return 'write';
  if (script.includes('.qsr_env')) return 'env';
  if (script.includes('npm ls')) return 'capture-resolved';
  if (script.includes('pip freeze')) return 'capture-resolved';
  if (script.includes('PRETTY_NAME')) return 'capture-env';
  if (script.includes('npm init') || script.includes('npm pkg')) return 'setup';
  return 'other';
}
