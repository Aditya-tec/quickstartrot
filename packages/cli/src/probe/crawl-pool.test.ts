import { describe, expect, it } from 'vitest';
import { createLimiter, domainOf } from './crawl-pool.js';

// `qsr plan` crawls with concurrency 4 and never two pages from the same domain at once (spec sections 7
// and 12), so a vendor's docs server sees at most one of our requests at a time.

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

describe('domainOf', () => {
  it('is the lower-cased host with its port', () => {
    expect(domainOf('https://Docs.Acme.dev/quickstart')).toBe('docs.acme.dev');
    expect(domainOf('http://127.0.0.1:4177/canary/pass-node.html')).toBe('127.0.0.1:4177');
  });

  it('falls back to the raw string for something that is not a URL', () => {
    expect(domainOf('not a url')).toBe('not a url');
  });
});

describe('createLimiter', () => {
  it('never runs more than N jobs at once', async () => {
    const run = createLimiter(4);
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        run(`host-${i}.dev`, async () => {
          active += 1;
          peak = Math.max(peak, active);
          await tick();
          active -= 1;
        }),
      ),
    );
    expect(peak).toBe(4);
  });

  it('never runs two jobs for the same domain at once, even with free slots', async () => {
    const run = createLimiter(4);
    const active = new Map<string, number>();
    let violated = false;
    const job = (domain: string) =>
      run(domain, async () => {
        active.set(domain, (active.get(domain) ?? 0) + 1);
        if ((active.get(domain) ?? 0) > 1) violated = true;
        await tick();
        active.set(domain, (active.get(domain) ?? 1) - 1);
      });
    await Promise.all([
      job('a.dev'),
      job('a.dev'),
      job('a.dev'),
      job('b.dev'),
      job('b.dev'),
      job('c.dev'),
    ]);
    expect(violated).toBe(false);
  });

  it('different domains do run side by side', async () => {
    const run = createLimiter(4);
    let active = 0;
    let peak = 0;
    const job = (domain: string) =>
      run(domain, async () => {
        active += 1;
        peak = Math.max(peak, active);
        await tick(15);
        active -= 1;
      });
    await Promise.all([job('a.dev'), job('b.dev'), job('c.dev')]);
    expect(peak).toBe(3);
  });

  it('returns each job value, and a failing job blocks neither the others nor its domain', async () => {
    const run = createLimiter(2);
    const results = await Promise.allSettled([
      run('a.dev', async () => {
        throw new Error('boom');
      }),
      run('a.dev', async () => 'second'),
      run('b.dev', async () => 'other'),
    ]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'fulfilled', 'fulfilled']);
    expect((results[1] as PromiseFulfilledResult<string>).value).toBe('second');
  });

  it('rejects a limit below 1', () => {
    expect(() => createLimiter(0)).toThrow(/at least 1/);
  });
});
