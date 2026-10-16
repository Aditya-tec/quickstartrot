import {
  PlanPayload,
  RunResult,
  StepIR,
  Target,
  type CompileBody,
  type CycleTool,
  type Extraction,
  type Logger,
  type PlanFile,
  type TargetInput,
} from '@qsr/core';
import type { ApiClient } from '../api-client.js';

// Shared fixtures for the probe pipeline tests (plan, execute, report).

export const CYCLE = '5d1b8c1e-2f4a-4b8e-9d3c-0123456789ab';
export const PLAN_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
export const HASH = 'a'.repeat(64);
export const NOW = new Date('2026-10-16T12:00:00.000Z');

export function target(slug: string, over: Partial<TargetInput> = {}): Target {
  return Target.parse({
    slug,
    name: `Tool ${slug}`,
    docsUrl: `https://docs.${slug}.dev/quickstart`,
    language: 'node',
    level: 3,
    runtime: { image: 'ghcr.io/aditya-tec/qsr-node:22' },
    extract: { root: 'main' },
    ...over,
  });
}

export const canaryTarget = (slug: string): Target =>
  target(slug, { docsUrl: `http://127.0.0.1:4177/canary/${slug}.html`, level: 3 });

export function extractionFor(t: Target, hash = HASH): Extraction {
  return {
    url: t.docsUrl,
    finalUrl: t.docsUrl,
    title: t.name,
    fetchedAt: NOW.toISOString(),
    contentHash: hash,
    blocks: [
      {
        index: 0,
        kind: 'code',
        lang: 'bash',
        text: `npm install ${t.slug}`,
        filenameHint: null,
        headingPath: [],
      },
    ],
  };
}

export const ir = (slug = 'acme'): StepIR =>
  StepIR.parse({
    irVersion: 1,
    language: 'node',
    projectInit: 'none',
    maxLevelReachable: 3,
    notes: '',
    steps: [
      {
        kind: 'shell',
        id: 's1',
        command: `npm install ${slug}`,
        source: { blockIndex: 0, lineStart: 1, lineEnd: 1 },
        expect: { exitCode: 0, authErrorIsPass: false, stdoutIncludes: [], timeoutSec: 180 },
      },
    ],
  });

export function planPayload(over: { accepted?: boolean; id?: string; contentHash?: string } = {}) {
  return PlanPayload.parse({
    id: over.id ?? PLAN_ID,
    contentHash: over.contentHash ?? HASH,
    configHash: 'c'.repeat(64),
    compilerVersion: '2026-10-16.5',
    model: 'openai/gpt-oss-120b',
    accepted: over.accepted ?? true,
    ir: over.accepted === false ? null : ir(),
    groundingReport:
      over.accepted === false
        ? { ok: false, violations: [{ stepId: 's1', rule: 'not_in_docs', detail: 'x' }] }
        : { ok: true, violations: [] },
    truncation: {
      truncated: false,
      totalBlocks: 1,
      includedBlocks: 1,
      omittedBlocks: 0,
      omittedBlockIndexes: [],
      clippedBlockIndexes: [],
    },
    createdAt: NOW.toISOString(),
  });
}

export const silent: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export interface RecordingLogger extends Logger {
  lines: { level: string; fields: Record<string, unknown>; msg?: string | undefined }[];
}
export function recordingLogger(): RecordingLogger {
  const lines: RecordingLogger['lines'] = [];
  const push = (level: string) => (fields: Record<string, unknown>, msg?: string) =>
    void lines.push({ level, fields, msg });
  return { lines, info: push('info'), warn: push('warn'), error: push('error') };
}

export interface ApiCall {
  path: string;
  body: unknown;
}
export interface FakeApiOptions {
  tools?: CycleTool[];
  /** Answer to POST /internal/compile; throw to simulate an API failure. */
  compile?: (body: CompileBody) => unknown;
  cycleId?: string;
}

/** An ApiClient that records every call and answers the plan job's endpoints. */
export function fakeApi(options: FakeApiOptions = {}) {
  const calls: ApiCall[] = [];
  const api: Pick<ApiClient, 'wakeApi' | 'post'> = {
    wakeApi: async () => {
      calls.push({ path: 'wake', body: null });
      return { attempts: 1, waitedMs: 0 };
    },
    post: (async (path: string, body: unknown) => {
      calls.push({ path, body });
      if (path === '/internal/targets/sync')
        return { created: [], updated: [], unchanged: [], disabled: [], keptDisabled: [] };
      if (path === '/internal/cycles')
        return { cycleId: options.cycleId ?? CYCLE, created: true, tools: options.tools ?? [] };
      if (path === '/internal/compile') {
        const reply = options.compile
          ? options.compile(body as CompileBody)
          : {
              status: 'ok',
              fromCache: false,
              stale: false,
              snapshotId: PLAN_ID,
              plan: planPayload(),
            };
        return reply;
      }
      throw new Error(`fakeApi: unexpected ${path}`);
    }) as ApiClient['post'],
  };
  return { api, calls, paths: () => calls.map((c) => c.path) };
}

export function cycleTool(t: Target, over: Partial<CycleTool> = {}): CycleTool {
  return {
    slug: t.slug,
    name: t.name,
    docsUrl: t.docsUrl,
    language: t.language,
    level: t.level,
    isCanary: t.slug.startsWith('canary-'),
    lastDurationMs: null,
    ...over,
  };
}

/** A RunResult as the executor writes it, with these steps (default: one passing shell step). */
export function runResultFor(slug: string, over: Partial<RunResult> = {}): RunResult {
  return RunResult.parse({
    toolSlug: slug,
    cycleId: CYCLE,
    attempt: 1,
    planId: PLAN_ID,
    snapshotHash: HASH,
    outcome: 'PASS',
    reachedLevel: 3,
    failedStepId: null,
    steps: [
      {
        stepId: 's1',
        ordinal: 0,
        kind: 'shell',
        outcome: 'PASS',
        exitCode: 0,
        durationMs: 1200,
        stdoutTail: 'ok',
        stderrTail: null,
        logFile: `${slug}-1/00-s1.log`,
      },
    ],
    imageDigest: `sha256:${'d'.repeat(64)}`,
    runnerEnv: { node: 'v22.1.0' },
    startedAt: '2026-10-16T12:00:00.000Z',
    finishedAt: '2026-10-16T12:00:05.000Z',
    ...over,
  });
}

export function readyPlan(
  t: Target,
  shard: number,
  over: { stale?: boolean; planId?: string | null; weightMs?: number | null } = {},
): PlanFile {
  return {
    version: 1,
    toolSlug: t.slug,
    cycleId: CYCLE,
    isCanary: t.slug.startsWith('canary-'),
    target: t,
    weightMs: over.weightMs ?? null,
    state: 'ready',
    shard,
    plan: {
      planId: over.planId === undefined ? PLAN_ID : over.planId,
      snapshotHash: HASH,
      ir: ir(t.slug),
      stale: over.stale ?? false,
      compilerVersion: '2026-10-16.5',
    },
  };
}
