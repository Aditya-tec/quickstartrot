import { describe, expect, it } from 'vitest';
import {
  budgetDecision,
  CHARS_PER_TOKEN,
  DEFAULT_DAILY_TOKEN_BUDGET,
  EXPECTED_OUTPUT_TOKENS,
  estimateCallTokens,
  estimateTokens,
} from './budget.js';

// The Groq free tier allows 200,000 tokens a day. A compile that would blow the budget must NOT call the
// provider (it returns `deferred`), because a quota error is not a COMPILER_ERROR and must never touch a
// status. 100% coverage is enforced on this file.

describe('constants', () => {
  it('defaults to 150,000 tokens a day: 75% of the free tier, leaving room for summaries and classification', () => {
    expect(DEFAULT_DAILY_TOKEN_BUDGET).toBe(150_000);
    expect(CHARS_PER_TOKEN).toBe(2.9);
    expect(EXPECTED_OUTPUT_TOKENS).toBeGreaterThan(0);
  });
});

describe('estimateTokens', () => {
  it('rounds up characters / 2.9 (measured on code JSON), and 0 characters is 0 tokens', () => {
    expect(estimateTokens(0)).toBe(0);
    expect(estimateTokens(29)).toBe(10);
    expect(estimateTokens(30)).toBe(11);
    expect(estimateTokens(10_000)).toBe(3449);
  });

  it('is conservative for bad input: negative or non-finite counts as nothing, never a negative cost', () => {
    expect(estimateTokens(-5)).toBe(0);
    expect(estimateTokens(Number.NaN)).toBe(0);
    expect(estimateTokens(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('estimateCallTokens', () => {
  it('is the prompt plus the output the call is expected to produce', () => {
    expect(estimateCallTokens(2900)).toBe(1000 + EXPECTED_OUTPUT_TOKENS);
    expect(estimateCallTokens(2900, 100)).toBe(1100);
  });
});

describe('budgetDecision', () => {
  it('allows a call that fits, and says how much is left afterwards', () => {
    expect(budgetDecision({ budget: 150_000, used: 100_000, cost: 5_000 })).toEqual({
      allowed: true,
      used: 100_000,
      cost: 5_000,
      remainingAfter: 45_000,
    });
  });

  it('the boundary is inclusive: using exactly the budget is allowed, one token more is not', () => {
    expect(budgetDecision({ budget: 1000, used: 900, cost: 100 }).allowed).toBe(true);
    expect(budgetDecision({ budget: 1000, used: 900, cost: 101 })).toMatchObject({
      allowed: false,
      remainingAfter: -1,
    });
  });

  it('refuses everything once the budget is spent, and when the budget is zero', () => {
    expect(budgetDecision({ budget: 1000, used: 1000, cost: 1 }).allowed).toBe(false);
    expect(budgetDecision({ budget: 1000, used: 5000, cost: 1 }).allowed).toBe(false);
    expect(budgetDecision({ budget: 0, used: 0, cost: 1 }).allowed).toBe(false);
  });

  it('a call that costs nothing is allowed while there is budget left', () => {
    expect(budgetDecision({ budget: 1000, used: 999, cost: 0 }).allowed).toBe(true);
  });

  it('treats unusable numbers as the worst case: a garbage budget refuses, garbage usage refuses', () => {
    expect(budgetDecision({ budget: Number.NaN, used: 0, cost: 1 }).allowed).toBe(false);
    expect(budgetDecision({ budget: 1000, used: Number.NaN, cost: 1 }).allowed).toBe(false);
    expect(budgetDecision({ budget: 1000, used: 0, cost: Number.NaN }).allowed).toBe(false);
    expect(budgetDecision({ budget: -5, used: 0, cost: 0 }).allowed).toBe(false);
  });
});
