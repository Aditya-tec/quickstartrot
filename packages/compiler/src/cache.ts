import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { GroundingReport, type Logger, noopLogger, StepIR } from '@qsr/core';

/** Spec section 5, `compiled_plans`: the cached outcome of compiling one page. */
export const CompiledPlan = z.object({
  toolSlug: z.string(),
  contentHash: z.string(),
  compilerVersion: z.string(),
  model: z.string(),
  ir: StepIR.nullable(), // null when rejected
  groundingReport: GroundingReport,
  accepted: z.boolean(),
  createdAt: z.iso.datetime(),
});
export type CompiledPlan = z.infer<typeof CompiledPlan>;

/** Spec section 8, compile flow step 1: lookup key is (tool, content hash, COMPILER_VERSION). */
export interface PlanKey {
  toolSlug: string;
  contentHash: string;
  compilerVersion: string;
}

/** Injected storage. The CLI uses files; the API will use the `compiled_plans` table (phase P6). */
export interface PlanCache {
  get(key: PlanKey): Promise<CompiledPlan | null>;
  put(plan: CompiledPlan): Promise<void>;
}

const keyId = (k: PlanKey): string => `${k.toolSlug}|${k.contentHash}|${k.compilerVersion}`;

export function createMemoryCache(): PlanCache {
  const store = new Map<string, CompiledPlan>();
  return {
    get: async (key) => store.get(keyId(key)) ?? null,
    put: async (plan) => void store.set(keyId(plan), plan),
  };
}

const SAFE = /^[A-Za-z0-9._-]+$/;

/** One JSON file per key under `<dir>/<slug>/<contentHash>.<version>.json`. A corrupt file is a miss. */
export function createFileCache(dir: string, log: Logger = noopLogger): PlanCache {
  const fileFor = (k: PlanKey): string => {
    for (const part of [k.toolSlug, k.contentHash, k.compilerVersion]) {
      if (!SAFE.test(part) || part === '.' || part === '..') {
        throw new Error(`unsafe plan cache key component: ${JSON.stringify(part)}`);
      }
    }
    return path.join(dir, k.toolSlug, `${k.contentHash}.${k.compilerVersion}.json`);
  };

  return {
    async get(key) {
      const file = fileFor(key);
      let text: string;
      try {
        text = await readFile(file, 'utf8');
      } catch {
        return null;
      }
      try {
        const parsed = CompiledPlan.safeParse(JSON.parse(text));
        if (parsed.success) return parsed.data;
        log.warn({ file, issues: parsed.error.issues.length }, 'ignoring invalid cached plan');
      } catch {
        log.warn({ file }, 'ignoring unreadable cached plan');
      }
      return null;
    },

    async put(plan) {
      const file = fileFor(plan);
      await mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, `${JSON.stringify(plan, null, 2)}\n`);
      await rename(tmp, file);
    },
  };
}
