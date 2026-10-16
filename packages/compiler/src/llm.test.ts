import { describe, expect, it } from 'vitest';
import { DEFAULT_COMPILER_CONFIG, resolveConfig } from './config.js';
import { createGroqClient, LlmError, type ChatMessage } from './llm.js';

const messages: ChatMessage[] = [
  { role: 'system', content: 'sys' },
  { role: 'user', content: 'hello JSON' },
];

const ok = (content: string, extra: Record<string, unknown> = {}) =>
  new Response(
    JSON.stringify({
      model: 'provider-model-id',
      choices: [{ message: { content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 12, completion_tokens: 34 },
      ...extra,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

function harness(
  responses: (Response | Error)[],
  over: Partial<Parameters<typeof createGroqClient>[0]> = {},
) {
  const requests: { url: string; init: RequestInit }[] = [];
  const sleeps: number[] = [];
  const queue = [...responses];
  const fetchStub: typeof fetch = async (url, init) => {
    requests.push({ url: String(url), init: init ?? {} });
    const next = queue.shift();
    if (next === undefined) throw new Error('no response left');
    if (next instanceof Error) throw next;
    return next;
  };
  const client = createGroqClient({
    apiKey: 'test-key',
    config: DEFAULT_COMPILER_CONFIG,
    fetch: fetchStub,
    sleep: async (ms) => void sleeps.push(ms),
    ...over,
  });
  return { client, requests, sleeps };
}

describe('createGroqClient: request', () => {
  it('posts JSON mode, temperature 0, the output cap and the configured model', async () => {
    const { client, requests } = harness([ok('{"a":1}')]);
    await client.complete(messages);
    const [req] = requests;
    expect(req?.url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect((req?.init.headers as Record<string, string>)['Authorization']).toBe('Bearer test-key');
    const body = JSON.parse(String(req?.init.body)) as Record<string, unknown>;
    expect(body).toEqual({
      model: DEFAULT_COMPILER_CONFIG.model,
      messages,
      temperature: 0,
      max_tokens: 4096,
      response_format: { type: 'json_object' },
      reasoning_effort: 'low',
    });
  });

  it('takes the model and limits from config, not from the client logic', async () => {
    const config = resolveConfig({
      model: 'some/other-model',
      maxOutputTokens: 2048,
      reasoningEffort: null,
    });
    const { client, requests } = harness([ok('{}')], { config, baseUrl: 'https://proxy.test/v1' });
    await client.complete(messages);
    expect(requests[0]?.url).toBe('https://proxy.test/v1/chat/completions');
    const body = JSON.parse(String(requests[0]?.init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ model: 'some/other-model', max_tokens: 2048, temperature: 0 });
    expect(body).not.toHaveProperty('reasoning_effort');
  });
});

describe('createGroqClient: response', () => {
  it('returns content, the provider model id, token counts and the finish reason', async () => {
    const { client } = harness([ok('{"a":1}')]);
    expect(await client.complete(messages)).toEqual({
      content: '{"a":1}',
      model: 'provider-model-id',
      tokensIn: 12,
      tokensOut: 34,
      finishReason: 'stop',
    });
  });

  it('tolerates missing usage, model and finish_reason', async () => {
    const bare = new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] }));
    const { client } = harness([bare]);
    expect(await client.complete(messages)).toEqual({
      content: '{}',
      model: DEFAULT_COMPILER_CONFIG.model,
      tokensIn: null,
      tokensOut: null,
      finishReason: null,
    });
  });

  it.each([
    ['no choices', {}],
    ['null content', { choices: [{ message: { content: null } }] }],
    ['empty content', { choices: [{ message: { content: '' } }] }],
  ])('reports %s as an empty reply', async (_name, payload) => {
    const { client } = harness([new Response(JSON.stringify(payload))]);
    await expect(client.complete(messages)).rejects.toMatchObject({
      name: 'LlmError',
      kind: 'empty',
    });
  });
});

describe('createGroqClient: failures', () => {
  it('retries 429 honouring Retry-After (capped at 60 s), then succeeds', async () => {
    const limited = (retryAfter: string) =>
      new Response('slow down', { status: 429, headers: { 'retry-after': retryAfter } });
    const { client, requests, sleeps } = harness([limited('7'), limited('120'), ok('{}')]);
    await client.complete(messages);
    expect(requests).toHaveLength(3);
    expect(sleeps).toEqual([7000, 60_000]);
  });

  it('keeps the provider Retry-After on the error it finally throws, uncapped, so a caller can decide whether waiting is worth it', async () => {
    const limited = (retryAfter?: string) =>
      new Response('slow down', {
        status: 429,
        ...(retryAfter ? { headers: { 'retry-after': retryAfter } } : {}),
      });
    const withHeader = harness([limited('20'), limited('7200')], { maxRetries: 1 });
    const err = (await withHeader.client.complete(messages).catch((e: unknown) => e)) as LlmError;
    expect(err).toBeInstanceOf(LlmError);
    expect(err.kind).toBe('unavailable');
    expect(err.retryAfterS).toBe(7200); // the LAST answer: a daily limit says so

    const without = harness(
      [new Response('x', { status: 503 }), new Response('x', { status: 503 })],
      {
        maxRetries: 1,
      },
    );
    const err2 = (await without.client.complete(messages).catch((e: unknown) => e)) as LlmError;
    expect(err2.retryAfterS).toBeNull();
  });

  it('retries four times by default, which rides out a one-minute free-tier window', async () => {
    const limited = () => new Response('x', { status: 429, headers: { 'retry-after': '15' } });
    const { client, requests } = harness([limited(), limited(), limited(), limited(), ok('{}')]);
    await client.complete(messages);
    expect(requests).toHaveLength(5);
  });

  it('backs off exponentially when there is no usable Retry-After', async () => {
    const { client, sleeps } = harness([
      new Response('x', { status: 500 }),
      new Response('x', { status: 503, headers: { 'retry-after': 'soon' } }),
      ok('{}'),
    ]);
    await client.complete(messages);
    expect(sleeps).toEqual([1000, 2000]);
  });

  it('retries network errors, including non-Error throws', async () => {
    const { client, requests } = harness([new Error('ECONNRESET'), ok('{}')]);
    await client.complete(messages);
    expect(requests).toHaveLength(2);
    const weird = createGroqClient({
      apiKey: 'k',
      config: DEFAULT_COMPILER_CONFIG,
      sleep: async () => undefined,
      maxRetries: 0,
      fetch: async () => Promise.reject('plain string'),
    });
    await expect(weird.complete(messages)).rejects.toThrow(/plain string/);
  });

  it('gives up after maxRetries and reports the model as unavailable, keeping the provider explanation', async () => {
    const { client, requests, sleeps } = harness(
      [
        new Response('x', { status: 503 }),
        new Response('x', { status: 503 }),
        new Response('Rate limit reached for tokens per minute (TPM): Limit 8000', { status: 429 }),
      ],
      { maxRetries: 2 },
    );
    const err = await client.complete(messages).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(err).toMatchObject({ kind: 'unavailable' });
    expect((err as Error).message).toMatch(/3 attempts.*HTTP 429.*tokens per minute \(TPM\)/);
    expect(requests).toHaveLength(3);
    expect(sleeps).toHaveLength(2); // no sleep after the last attempt
  });

  it('does not retry a rejection (bad key, request too large) and includes the provider detail', async () => {
    const { client, requests } = harness([
      new Response('{"error":"Invalid API Key"}', { status: 401 }),
    ]);
    const err = await client.complete(messages).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'rejected', status: 401 });
    expect((err as Error).message).toContain('Invalid API Key');
    expect(requests).toHaveLength(1);
  });

  it('uses the real sleep and global fetch by default (constructed without injection)', () => {
    expect(createGroqClient({ apiKey: 'k', config: DEFAULT_COMPILER_CONFIG }).complete).toBeTypeOf(
      'function',
    );
  });
});

describe('config', () => {
  it('keeps the spec limits as defaults and lets callers override', () => {
    expect(DEFAULT_COMPILER_CONFIG).toMatchObject({ temperature: 0, maxOutputTokens: 4096 });
    expect(resolveConfig()).toEqual(DEFAULT_COMPILER_CONFIG);
    expect(resolveConfig({ model: 'x' }).model).toBe('x');
  });
});
