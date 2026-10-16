import {
  type Extraction,
  type GroundingReport,
  type Logger,
  noopLogger,
  StepIR,
  type Target,
} from '@qsr/core';
import { type CompiledPlan, type PlanCache, type PlanKey } from './cache.js';
import { DEFAULT_COMPILER_CONFIG, type CompilerConfig } from './config.js';
import { fillFileContent } from './fill.js';
import { finalizePlan } from './finalize.js';
import {
  quarantineDestructive,
  quarantineInteractive,
  validateGrounding,
  type GroundingContext,
} from './grounding/index.js';
import type { ChatMessage, LlmCallRecord, LlmClient, LlmResponse } from './llm.js';
import {
  buildUserMessage,
  COMPILER_VERSION,
  groundingRetryMessage,
  schemaRetryMessage,
  SYSTEM_PROMPT,
} from './prompt.js';

export interface CompileDeps {
  llm: LlmClient;
  cache: PlanCache;
  config?: CompilerConfig;
  log?: Logger;
  /** Ignore a cached plan and compile again (the new plan is still stored). */
  refresh?: boolean;
  /** Monotonic milliseconds, for call latency. Injected for tests. */
  now?: () => number;
  /** Wall clock for `createdAt`. Injected for tests. */
  clock?: () => Date;
}

export interface CompileResult {
  plan: CompiledPlan;
  fromCache: boolean;
  /** One record per model call made by this compile (empty on a cache hit). */
  llmCalls: LlmCallRecord[];
}

type Interpreted =
  { kind: 'invalid'; error: string } | { kind: 'checked'; ir: StepIR; report: GroundingReport };

/** The model often omits `expect` on shell/run steps; the harness sets it anyway, so default it. */
function withExpectDefaults(json: unknown): unknown {
  if (
    typeof json !== 'object' ||
    json === null ||
    !('steps' in json) ||
    !Array.isArray(json.steps)
  ) {
    return json;
  }
  const steps: unknown[] = json.steps.map((s: unknown) =>
    typeof s === 'object' &&
    s !== null &&
    'kind' in s &&
    (s.kind === 'shell' || s.kind === 'run') &&
    !('expect' in s)
      ? { ...s, expect: {} }
      : s,
  );
  return { ...json, steps };
}

function interpret(response: LlmResponse, target: Target, ctx: GroundingContext): Interpreted {
  if (response.finishReason === 'length') {
    return {
      kind: 'invalid',
      error: 'the reply hit the output limit and was cut off; make the plan shorter',
    };
  }
  let json: unknown;
  try {
    json = JSON.parse(response.content);
  } catch (err) {
    return { kind: 'invalid', error: `the reply is not valid JSON (${(err as Error).message})` };
  }
  const parsed = StepIR.safeParse(withExpectDefaults(json));
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 8)
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    return { kind: 'invalid', error: `the reply does not match the plan schema: ${issues}` };
  }
  // Destructive steps become manual steps, file content is copied from the cited lines, the
  // harness-owned fields are fixed, and then the deterministic grounding validator decides.
  const { ir: safe } = quarantineDestructive(parsed.data, ctx);
  const { ir: stopped } = quarantineInteractive(safe, ctx);
  const ir = finalizePlan(fillFileContent(stopped, ctx), target);
  return { kind: 'checked', ir, report: validateGrounding(ir, ctx) };
}

/**
 * Spec section 8, compile flow. Cache lookup by (tool, content hash, COMPILER_VERSION); on a miss
 * one model call, with at most one retry after a schema error and one after a grounding failure.
 * A plan that still fails is stored with accepted = false and ir = null (our failure, COMPILER_ERROR,
 * never shown as the vendor's). Model or network failures throw LlmError and are NOT cached.
 */
export async function compile(
  target: Target,
  extraction: Extraction,
  deps: CompileDeps,
): Promise<CompileResult> {
  const config = deps.config ?? DEFAULT_COMPILER_CONFIG;
  const log = deps.log ?? noopLogger;
  const now = deps.now ?? (() => performance.now());
  const clock = deps.clock ?? (() => new Date());
  const key: PlanKey = {
    toolSlug: target.slug,
    contentHash: extraction.contentHash,
    compilerVersion: COMPILER_VERSION,
  };
  const logFields = {
    toolSlug: target.slug,
    contentHash: key.contentHash,
    compilerVersion: COMPILER_VERSION,
  };

  if (!deps.refresh) {
    const hit = await deps.cache.get(key);
    if (hit) {
      log.info({ ...logFields, accepted: hit.accepted }, 'plan cache hit');
      return { plan: hit, fromCache: true, llmCalls: [] };
    }
  }
  log.info(logFields, 'plan cache miss');

  const ctx: GroundingContext = {
    blocks: extraction.blocks,
    placeholders: target.placeholders,
    language: target.language,
  };
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: buildUserMessage(target, extraction, config.maxDocsChars) },
  ];
  const llmCalls: LlmCallRecord[] = [];

  const callModel = async (): Promise<LlmResponse> => {
    const started = now();
    const record = { purpose: 'compile' as const, model: config.model };
    try {
      const response = await deps.llm.complete(messages);
      const done: LlmCallRecord = {
        ...record,
        model: response.model,
        tokensIn: response.tokensIn,
        tokensOut: response.tokensOut,
        latencyMs: Math.round(now() - started),
        ok: true,
        error: null,
      };
      llmCalls.push(done);
      log.info({ ...logFields, ...done }, 'llm call');
      return response;
    } catch (err) {
      const failed: LlmCallRecord = {
        ...record,
        tokensIn: null,
        tokensOut: null,
        latencyMs: Math.round(now() - started),
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
      llmCalls.push(failed);
      log.error({ ...logFields, ...failed }, 'llm call failed');
      throw err;
    }
  };

  let schemaRetries = 0;
  let groundingRetries = 0;
  let model = config.model;
  let ir: StepIR | null = null;
  let report: GroundingReport;

  for (;;) {
    const response = await callModel();
    model = response.model;
    const outcome = interpret(response, target, ctx);

    if (outcome.kind === 'invalid') {
      if (schemaRetries === 0) {
        schemaRetries++;
        log.warn({ ...logFields, error: outcome.error }, 'schema error, retrying once');
        messages.push(
          { role: 'assistant', content: response.content },
          { role: 'user', content: schemaRetryMessage(outcome.error) },
        );
        continue;
      }
      report = { ok: false, violations: [{ stepId: '*', rule: 'schema', detail: outcome.error }] };
      break;
    }

    report = outcome.report;
    if (report.ok) {
      ir = outcome.ir;
      break;
    }
    if (groundingRetries === 0) {
      groundingRetries++;
      log.warn({ ...logFields, violations: report.violations }, 'grounding failed, retrying once');
      messages.push(
        { role: 'assistant', content: response.content },
        { role: 'user', content: groundingRetryMessage(report.violations) },
      );
      continue;
    }
    break;
  }

  const plan: CompiledPlan = {
    ...key,
    toolSlug: target.slug,
    model,
    ir,
    groundingReport: report,
    accepted: report.ok,
    createdAt: clock().toISOString(),
  };
  await deps.cache.put(plan);
  log.info({ ...logFields, accepted: plan.accepted, llmCalls: llmCalls.length }, 'plan compiled');
  return { plan, fromCache: false, llmCalls };
}
