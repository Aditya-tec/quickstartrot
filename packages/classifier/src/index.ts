export { classify, signatureFor, unknownClassification } from './classify.js';
export { inputFromRunResult, type RunInfo } from './from-run.js';
export { RULES, textOf, type Rule } from './rules.js';
export { computeSignature, firstErrorLines, normalize } from './signature.js';
export type {
  Classification,
  ClassificationSource,
  ClassifyInput,
  FailingStep,
  RunContext,
} from './types.js';
export {
  ACCEPT_CONFIDENCE,
  classifyWithFallback,
  LLM_CLASSES,
  LOG_LINES,
  type ClassifierLlm,
  type ClassifierMessage,
  type FallbackDeps,
} from './fallback.js';
