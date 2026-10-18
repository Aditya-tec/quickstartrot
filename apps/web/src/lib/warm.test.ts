import { describe, expect, it } from 'vitest';
import { createWarmer } from './warm';

// Opening /submit wakes the API (it sleeps on a free tier and takes up to a minute), so that by the time a visitor has typed a URL it is
// awake. The wake-up is one GET /health: nothing is sent, nothing is read, and it never fails the page.

const response = (status: number): Response => new Response('{}', { status });
const base = 'https://api.test';

describe('createWarmer', () => {
  it('asks GET /health once and says whether the API answered', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const warm = createWarmer({
      fetch: async (url, init) => {
        calls.push({ url: String(url), ...(init ? { init } : {}) });
        return response(200);
      },
      apiBaseUrl: base,
      now: () => 0,
    });
    expect(await warm()).toBe('woken');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.test/health');
    expect(calls[0]?.init?.method ?? 'GET').toBe('GET');
  });

  it('sends no body, no credentials and no cookies', async () => {
    let init: RequestInit | undefined;
    const warm = createWarmer({
      fetch: async (_url, i) => {
        init = i;
        return response(200);
      },
      apiBaseUrl: base,
      now: () => 0,
    });
    await warm();
    expect(init?.body).toBeUndefined();
    expect(init?.credentials ?? 'omit').toBe('omit');
    expect(JSON.stringify(init?.headers ?? {})).not.toMatch(/authorization|cookie|token/i);
  });

  it('never throws: a refused connection, a timeout or a 503 are "asleep", not errors', async () => {
    for (const fetch of [
      async () => {
        throw new Error('ECONNRESET');
      },
      async () => response(503),
      async () => response(502),
    ]) {
      const warm = createWarmer({ fetch, apiBaseUrl: base, now: () => 0 });
      expect(await warm()).toBe('asleep');
    }
  });

  it('gives up when the server is still waking, instead of holding a function for a minute', async () => {
    const warm = createWarmer({
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
      apiBaseUrl: base,
      now: () => 0,
      timeoutMs: 20,
    });
    expect(await warm()).toBe('asleep');
  });

  it('asks at most once in the window: a burst of page views is one request', async () => {
    let n = 0;
    let t = 1_000;
    const warm = createWarmer({
      fetch: async () => {
        n += 1;
        return response(200);
      },
      apiBaseUrl: base,
      now: () => t,
      windowMs: 60_000,
    });
    expect(await warm()).toBe('woken');
    t += 59_000;
    expect(await warm()).toBe('skipped');
    expect(await warm()).toBe('skipped');
    expect(n).toBe(1);
    t += 2_000;
    expect(await warm()).toBe('woken');
    expect(n).toBe(2);
  });

  it('does not count an asleep answer as warmed: the next view tries again', async () => {
    let n = 0;
    const warm = createWarmer({
      fetch: async () => {
        n += 1;
        return response(503);
      },
      apiBaseUrl: base,
      now: () => 5,
    });
    await warm();
    await warm();
    expect(n).toBe(2);
  });
});
