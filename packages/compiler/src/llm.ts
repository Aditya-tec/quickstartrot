import type { CompilerConfig } from './config.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmResponse {
  content: string;
  model: string;
  tokensIn: number | null;
  tokensOut: number | null;
  /** 'stop' normally; 'length' means the reply hit the output cap and is probably cut off. */
  finishReason: string | null;
}

/** The only thing the compiler needs from a model provider. Injected, so tests use a script. */
export interface LlmClient {
  complete(messages: readonly ChatMessage[]): Promise<LlmResponse>;
}

/** One row for the `llm_calls` table (spec section 5); the API persists these in phase P6. */
export interface LlmCallRecord {
  purpose: 'compile' | 'classify' | 'summarize';
  model: string;
  tokensIn: number | null;
  tokensOut: number | null;
  latencyMs: number;
  ok: boolean;
  error: string | null;
}

/** Infrastructure failure talking to the model (never a verdict on the vendor's docs). */
export class LlmError extends Error {
  override readonly name = 'LlmError';

  constructor(
    message: string,
    readonly kind: 'unavailable' | 'rejected' | 'empty',
    readonly status: number | null = null,
    /** The provider's last Retry-After, in seconds (uncapped: a daily limit says so), or null. */
    readonly retryAfterS: number | null = null,
  ) {
    super(message);
  }
}

export interface GroqOptions {
  apiKey: string;
  config: CompilerConfig;
  baseUrl?: string;
  /** Extra attempts after a 429/5xx/network error. */
  maxRetries?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/** Free-tier limits are per minute, so a Retry-After longer than a minute is not worth waiting for. */
const MAX_RETRY_AFTER_S = 60;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface ChatCompletion {
  model?: string;
  choices?: { message?: { content?: string | null }; finish_reason?: string | null }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/**
 * Groq via its OpenAI-compatible chat API: JSON output mode, temperature 0, capped output.
 * 429 and 5xx responses (the free tier rate-limits aggressively) and network errors are retried
 * with backoff, honouring Retry-After; anything else is reported as a rejection.
 */
export function createGroqClient(options: GroqOptions): LlmClient {
  const { apiKey, config } = options;
  const url = `${options.baseUrl ?? 'https://api.groq.com/openai/v1'}/chat/completions`;
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const maxRetries = options.maxRetries ?? 4;

  return {
    async complete(messages) {
      const body = JSON.stringify({
        model: config.model,
        messages,
        temperature: config.temperature,
        max_tokens: config.maxOutputTokens,
        response_format: { type: 'json_object' },
        ...(config.reasoningEffort ? { reasoning_effort: config.reasoningEffort } : {}),
      });

      let lastFailure = 'no attempt made';
      let lastRetryAfterS: number | null = null;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        let waitMs = 1000 * 2 ** attempt;
        try {
          const res = await doFetch(url, {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body,
          });
          if (res.status === 429 || res.status >= 500) {
            // Keep the provider's explanation: on the free tier it says WHICH limit was hit.
            lastFailure = `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`;
            const retryAfter = Number(res.headers.get('retry-after'));
            lastRetryAfterS = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null;
            if (retryAfter > 0) waitMs = Math.min(retryAfter, MAX_RETRY_AFTER_S) * 1000;
          } else if (!res.ok) {
            const detail = (await res.text()).slice(0, 300);
            throw new LlmError(`HTTP ${res.status}: ${detail}`, 'rejected', res.status);
          } else {
            const json = (await res.json()) as ChatCompletion;
            const choice = json.choices?.[0];
            const content = choice?.message?.content;
            if (typeof content !== 'string' || content === '') {
              throw new LlmError('the model returned no content', 'empty', res.status);
            }
            return {
              content,
              model: json.model ?? config.model,
              tokensIn: json.usage?.prompt_tokens ?? null,
              tokensOut: json.usage?.completion_tokens ?? null,
              finishReason: choice?.finish_reason ?? null,
            };
          }
        } catch (err) {
          if (err instanceof LlmError) throw err;
          lastFailure = err instanceof Error ? err.message : String(err);
        }
        if (attempt < maxRetries) await sleep(waitMs);
      }
      throw new LlmError(
        `model unavailable after ${maxRetries + 1} attempts (${lastFailure})`,
        'unavailable',
        null,
        lastRetryAfterS,
      );
    },
  };
}
