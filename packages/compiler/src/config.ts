/**
 * Compiler settings. The model name lives here (and in the QSR_COMPILER_MODEL environment variable
 * read by the CLI), never in the compile logic, because hosted model names are retired often:
 * the spec's default, llama-3.3-70b-versatile, is no longer served on the project's Groq account.
 */
export interface CompilerConfig {
  /** Model id as the provider names it. */
  model: string;
  /** Spec section 8: temperature 0. */
  temperature: number;
  /** Spec section 8: max 4k output tokens (reasoning models count their reasoning inside this). */
  maxOutputTokens: number;
  /** Reasoning models only (openai/gpt-oss-*): keeps hidden reasoning small inside the output cap. */
  reasoningEffort: 'low' | 'medium' | 'high' | null;
  /**
   * Budget for the documentation JSON in the prompt; later blocks are omitted and flagged. Sized for
   * Groq's free tier, which rejects any request over 8,000 prompt tokens (measured: ~2.9 characters of
   * code JSON per token), leaving room for the system prompt and one retry exchange.
   */
  maxDocsChars: number;
}

export const DEFAULT_COMPILER_CONFIG: CompilerConfig = {
  model: 'openai/gpt-oss-120b',
  temperature: 0,
  maxOutputTokens: 4096,
  reasoningEffort: 'low',
  maxDocsChars: 10_000,
};

export function resolveConfig(overrides: Partial<CompilerConfig> = {}): CompilerConfig {
  return { ...DEFAULT_COMPILER_CONFIG, ...overrides };
}
