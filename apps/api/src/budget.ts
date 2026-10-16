// The model-token budget guard. Groq's free tier allows 200,000 tokens a day; GROQ_DAILY_TOKEN_BUDGET
// (default 150,000) is compared with the tokens recorded in llm_calls over the last 24 hours BEFORE every
// call. A call that would exceed it is not made: /internal/compile answers `deferred`, never COMPILER_ERROR,
// because running out of quota says nothing about the vendor's docs and must never touch a status.
// Pure, so it can be held at 100% coverage.

export const DEFAULT_DAILY_TOKEN_BUDGET = 150_000;
/** Measured on the compiler's JSON prompts (spec section 8, Groq limits). */
export const CHARS_PER_TOKEN = 2.9;
/** What a compile call typically produces; a plan is a few hundred tokens, a reasoning model adds more. */
export const EXPECTED_OUTPUT_TOKENS = 1_500;

/** Tokens for this many characters, rounded up. Integer arithmetic: 29 / 2.9 is not exactly 10 in floating point. */
export function estimateTokens(chars: number): number {
  if (!Number.isFinite(chars) || chars <= 0) return 0;
  return Math.ceil((chars * 10) / (CHARS_PER_TOKEN * 10));
}

/** What one model call is expected to cost: its prompt plus the output it will produce. */
export function estimateCallTokens(
  promptChars: number,
  expectedOutputTokens: number = EXPECTED_OUTPUT_TOKENS,
): number {
  return estimateTokens(promptChars) + expectedOutputTokens;
}

export interface BudgetDecision {
  allowed: boolean;
  used: number;
  cost: number;
  /** Negative when the call would overspend. */
  remainingAfter: number;
}

const usable = (n: number): boolean => Number.isFinite(n) && n >= 0;

/**
 * May a call costing `cost` tokens be made, given `used` tokens already spent in the window? The boundary is
 * inclusive. Any unusable number (NaN, negative) is the worst case: the answer is no.
 */
export function budgetDecision(input: {
  budget: number;
  used: number;
  cost: number;
}): BudgetDecision {
  const { budget, used, cost } = input;
  const remainingAfter = budget - used - cost;
  return {
    allowed: usable(budget) && usable(used) && usable(cost) && remainingAfter >= 0,
    used,
    cost,
    remainingAfter,
  };
}
