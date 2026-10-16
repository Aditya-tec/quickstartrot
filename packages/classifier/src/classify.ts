import type { FailureClass } from '@qsr/core';
import { firstLine, RULES, textOf } from './rules.js';
import { computeSignature, firstErrorLines } from './signature.js';
import type { Classification, ClassifyInput } from './types.js';

/** The signature of this failure under a class: step kind plus the first error lines of its output. */
export function signatureFor(failureClass: FailureClass, input: ClassifyInput): string {
  return computeSignature(
    failureClass,
    input.step?.kind ?? 'none',
    firstErrorLines(textOf(input.step)),
  );
}

/**
 * Spec section 10: rules run first, in order, and the first match wins. Returns null when no rule
 * matches; the caller then asks the LLM fallback (`classifyWithFallback`) or records UNKNOWN.
 * Pure: no I/O, no clock.
 */
export function classify(input: ClassifyInput): Classification | null {
  const kind = input.step?.kind ?? null;
  for (const rule of RULES) {
    if (rule.stepKinds && (kind === null || !rule.stepKinds.includes(kind))) continue;
    if (rule.guard && !rule.guard(input)) continue;
    const evidence = rule.when ? rule.when(input) : firstLine(input.step, rule.pattern);
    if (evidence === null) continue;
    return {
      failureClass: rule.failureClass,
      ruleId: rule.id,
      evidenceLine: evidence,
      signature: signatureFor(rule.failureClass, input),
      source: 'rule',
      confidence: null,
    };
  }
  return null;
}

/** No rule matched and the LLM fallback did not (or could not) classify: UNKNOWN, for human review. */
export function unknownClassification(input: ClassifyInput): Classification {
  return {
    failureClass: 'UNKNOWN',
    ruleId: 'none',
    evidenceLine: null,
    signature: signatureFor('UNKNOWN', input),
    source: 'none',
    confidence: null,
  };
}
