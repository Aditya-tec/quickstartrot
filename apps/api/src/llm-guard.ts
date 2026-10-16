import { gt, sql } from 'drizzle-orm';
import { LlmError, type ChatMessage, type LlmClient, type LlmResponse } from '@qsr/compiler';
import { llmCalls, type Db } from '@qsr/db';
import { budgetDecision, estimateCallTokens, type BudgetDecision } from './budget.js';

// Every model call the API makes goes through here: it is refused when the day's token budget would be
// exceeded or the request already used its calls, and every call that is made is logged in llm_calls
// (spec section 5), failed ones too, so the budget sees what the provider saw.

const WINDOW_MS = 24 * 60 * 60 * 1000;

/** The call was not made: it would exceed GROQ_DAILY_TOKEN_BUDGET. */
export class BudgetExceededError extends Error {
  override readonly name = 'BudgetExceededError';
  constructor(readonly decision: BudgetDecision) {
    super(
      `the model-token budget would be exceeded (${decision.used} used, ${decision.cost} needed)`,
    );
  }
}

/** The call was not made: this request already used its allowance of model calls. */
export class CallLimitError extends Error {
  override readonly name = 'CallLimitError';
  constructor(readonly limit: number) {
    super(`a request may make at most ${limit} model calls`);
  }
}

/** Tokens (in + out, every purpose, failed calls included) recorded in the 24 hours up to `now`. */
export async function tokensUsedInWindow(db: Db, now: Date): Promise<number> {
  const since = new Date(now.getTime() - WINDOW_MS);
  const [row] = await db
    .select({
      used: sql<string>`coalesce(sum(coalesce(${llmCalls.tokensIn}, 0) + coalesce(${llmCalls.tokensOut}, 0)), 0)`,
    })
    .from(llmCalls)
    .where(gt(llmCalls.createdAt, since));
  return Number(row?.used ?? 0);
}

export interface GuardOptions {
  db: Db;
  inner: LlmClient;
  purpose: 'compile' | 'classify' | 'summarize';
  budget: number;
  maxCalls: number;
  now: () => Date;
  /** Model name to record when a call fails before the provider answers. */
  model: string;
}

const promptChars = (messages: readonly ChatMessage[]): number =>
  messages.reduce((n, m) => n + m.content.length, 0);

export class GuardedLlm implements LlmClient {
  private made = 0;

  constructor(private readonly o: GuardOptions) {}

  get callsMade(): number {
    return this.made;
  }

  async complete(messages: readonly ChatMessage[]): Promise<LlmResponse> {
    if (this.made >= this.o.maxCalls) throw new CallLimitError(this.o.maxCalls);
    const used = await tokensUsedInWindow(this.o.db, this.o.now());
    const decision = budgetDecision({
      budget: this.o.budget,
      used,
      cost: estimateCallTokens(promptChars(messages)),
    });
    if (!decision.allowed) throw new BudgetExceededError(decision);

    this.made++;
    const started = performance.now();
    try {
      const response = await this.o.inner.complete(messages);
      await this.record({
        model: response.model,
        tokensIn: response.tokensIn,
        tokensOut: response.tokensOut,
        latencyMs: Math.round(performance.now() - started),
        ok: true,
        error: null,
      });
      return response;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.record({
        model: this.o.model,
        tokensIn: null,
        tokensOut: null,
        latencyMs: Math.round(performance.now() - started),
        ok: false,
        error: message.slice(0, 500),
      });
      // Whatever went wrong on the way to the provider is an infrastructure failure, never a verdict on the docs.
      throw err instanceof LlmError ? err : new LlmError(message, 'unavailable');
    }
  }

  private async record(row: {
    model: string;
    tokensIn: number | null;
    tokensOut: number | null;
    latencyMs: number;
    ok: boolean;
    error: string | null;
  }): Promise<void> {
    await this.o.db
      .insert(llmCalls)
      .values({ purpose: this.o.purpose, createdAt: this.o.now(), ...row });
  }
}
