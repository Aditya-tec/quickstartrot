// The executor talks to Docker only through this interface (spec section 4: the library packages
// take their dependencies by injection). Unit tests use a fake; `createDockerCli` (docker-cli.ts)
// is the real implementation that shells out to the `docker` binary.

/** Spec section 9: `--memory 2g --cpus 2 --pids-limit 512`. */
export interface ResourceLimits {
  memory: string;
  cpus: string;
  pidsLimit: number;
}

export const DEFAULT_LIMITS: ResourceLimits = { memory: '2g', cpus: '2', pidsLimit: 512 };

export interface ContainerSpec {
  name: string;
  /** Image reference to run; ideally pinned by digest. */
  image: string;
  limits: ResourceLimits;
  labels: Readonly<Record<string, string>>;
}

export interface ExecOptions {
  /** Written to the process's stdin, then closed. */
  stdin?: string;
  /** Host-side deadline for the whole `docker exec`; a safety net behind the in-container `timeout`. */
  timeoutMs: number;
  signal?: AbortSignal | undefined;
  onStdout(chunk: Buffer): void;
  onStderr(chunk: Buffer): void;
}

export interface ExecOutcome {
  /** null when the host killed the exec (deadline or abort) before an exit code was produced. */
  exitCode: number | null;
  /** The host-side deadline expired. */
  timedOut: boolean;
}

export interface ImageInfo {
  /** The image ID (config digest), e.g. `sha256:...`. */
  id: string;
  /** Registry digests, e.g. `ghcr.io/owner/qsr-node@sha256:...`. Empty for an image built locally. */
  repoDigests: readonly string[];
}

export interface DockerClient {
  /** null when the image is not present locally. */
  inspectImage(image: string): Promise<ImageInfo | null>;
  pullImage(image: string): Promise<void>;
  /** Starts a long-lived container running `sleep infinity` with the sandbox restrictions. */
  start(spec: ContainerSpec): Promise<void>;
  exec(name: string, argv: readonly string[], options: ExecOptions): Promise<ExecOutcome>;
  /** `docker rm -f`; must not throw if the container does not exist. */
  remove(name: string): Promise<void>;
  serverVersion(): Promise<string>;
}
