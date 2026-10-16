import { describe, expect, it } from 'vitest';
import { GitHubError, reportHarnessProblem } from './github.js';

// Spec section 14, "Alert channel": when a cycle is invalid or the harness error rate exceeds 5%, the report
// job opens (or comments on) a GitHub issue labelled `harness` in our own repo, with the default token
// (issues: write on the report job only). One open issue at a time: no duplicates.

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}
function fake(replies: Response[]) {
  const calls: Call[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      method: init?.method ?? 'GET',
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return replies.shift() ?? new Response('{}', { status: 200 });
  }) as typeof fetch;
  return { calls, fetchFn };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const input = (fetchFn: typeof fetch) => ({
  fetch: fetchFn,
  token: 'ghs_testtoken',
  repository: 'Aditya-tec/quickstartrot',
  title: 'Probe cycle needs attention',
  body: 'The cycle was invalid.',
});

describe('reportHarnessProblem', () => {
  it('opens a labelled issue when none is open', async () => {
    const { calls, fetchFn } = fake([
      json([]),
      json({ number: 12, html_url: 'https://github.com/o/r/issues/12' }, 201),
    ]);
    const out = await reportHarnessProblem(input(fetchFn));
    expect(out).toEqual({ action: 'created', url: 'https://github.com/o/r/issues/12' });
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.url).toBe(
      'https://api.github.com/repos/Aditya-tec/quickstartrot/issues?labels=harness&state=open&per_page=30',
    );
    expect(calls[1]).toMatchObject({
      method: 'POST',
      url: 'https://api.github.com/repos/Aditya-tec/quickstartrot/issues',
      body: {
        title: 'Probe cycle needs attention',
        body: 'The cycle was invalid.',
        labels: ['harness'],
      },
    });
  });

  it('comments on the open issue instead of opening a second one', async () => {
    const { calls, fetchFn } = fake([
      json([{ number: 7, html_url: 'https://github.com/o/r/issues/7' }]),
      json({ html_url: 'https://github.com/o/r/issues/7#issuecomment-1' }, 201),
    ]);
    const out = await reportHarnessProblem(input(fetchFn));
    expect(out.action).toBe('commented');
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({
      method: 'POST',
      url: 'https://api.github.com/repos/Aditya-tec/quickstartrot/issues/7/comments',
      body: { body: 'The cycle was invalid.' },
    });
  });

  it('ignores pull requests that carry the label', async () => {
    const { calls, fetchFn } = fake([
      json([{ number: 3, pull_request: {}, html_url: 'x' }]),
      json({ number: 4, html_url: 'https://github.com/o/r/issues/4' }, 201),
    ]);
    expect((await reportHarnessProblem(input(fetchFn))).action).toBe('created');
    expect(calls[1]?.method).toBe('POST');
  });

  it('sends the token only as a Bearer header, never in a URL or a body', async () => {
    const { calls, fetchFn } = fake([json([]), json({ number: 1, html_url: 'u' }, 201)]);
    await reportHarnessProblem(input(fetchFn));
    for (const c of calls) {
      expect(c.headers['Authorization']).toBe('Bearer ghs_testtoken');
      expect(c.headers['User-Agent']).toMatch(/quickstartrot/i);
      expect(c.url).not.toContain('ghs_testtoken');
      expect(JSON.stringify(c.body ?? '')).not.toContain('ghs_testtoken');
    }
  });

  it('a GitHub error is a GitHubError that names the status and not the token', async () => {
    const { fetchFn } = fake([json({ message: 'Resource not accessible by integration' }, 403)]);
    const err = await reportHarnessProblem(input(fetchFn)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubError);
    expect(String(err)).toContain('403');
    expect(String(err)).not.toContain('ghs_testtoken');
  });

  it('a network failure is a GitHubError too', async () => {
    const fetchFn = (async () => {
      throw new Error('socket hang up');
    }) as unknown as typeof fetch;
    await expect(reportHarnessProblem(input(fetchFn))).rejects.toBeInstanceOf(GitHubError);
  });
});
