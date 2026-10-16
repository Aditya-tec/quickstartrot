export {
  CHECK_IDS,
  HARNESS_CHECK_KIND,
  checkableFiles,
  planChecks,
  type CheckPlan,
  type HarnessCheck,
} from './checks.js';
export {
  executePlan,
  isInstallCommand,
  persistRunResult,
  pickDigest,
  reachedLevel,
  shellQuote,
  type ExecuteDeps,
  type ExecuteInput,
} from './execute.js';
export {
  AUTH_PATTERNS,
  DRIFT_PATTERNS,
  evaluateExpect,
  matchAuthPattern,
  matchDriftPattern,
  type StepEvidence,
  type Verdict,
} from './expect.js';
export { StepOutput, LOG_CAP_BYTES, TAIL_BYTES, type StepOutputResult } from './sink.js';
export {
  DEFAULT_LIMITS,
  type ContainerSpec,
  type DockerClient,
  type ExecOptions,
  type ExecOutcome,
  type ImageInfo,
  type ResourceLimits,
} from './docker.js';
export { buildRunArgs, createDockerCli, scrubbedEnv, type DockerCliOptions } from './docker-cli.js';
