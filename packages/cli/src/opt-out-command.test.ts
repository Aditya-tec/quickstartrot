import { describe, expect, it } from 'vitest';
import { OPT_OUT, OptOutResponse } from '@qsr/core';
import type { ApiClient } from './api-client.js';
import { hideHistoryCommand, optOutCommand } from './opt-out-command.js';
import { recordingLogger } from './probe/probe.test-utils.js';

// `qsr opt-out <slug> [--hide-history]` and `qsr hide-history <slug>`: how a person applies a vendor's request. Probing of the tool stops
// (the API switches it off and a target sync never switches it back on), its page stays up labelled as no longer monitored at the vendor's
// request, and the past results are hidden ONLY with --hide-history or the separate hide-history command, because the vendor has to ask.

const answer = (over: Partial<OptOutResponse> = {}): OptOutResponse =>
  OptOutResponse.parse({
    slug: 'acme-node',
    optedOutAt: '2026-10-19T09:00:00.000Z',
    historyHidden: false,
    ...over,
  });

function fakeApi(response: OptOutResponse = answer(), fail?: Error) {
  const posts: { path: string; body: unknown }[] = [];
  return {
    posts,
    api: {
      wakeApi: async () => ({ status: 'up' as const, attempts: 1, waitedMs: 0 }),
      post: (async (path: string, body: unknown) => {
        posts.push({ path, body });
        if (fail) throw fail;
        return response;
      }) as Pick<ApiClient, 'post'>['post'],
    },
  };
}
const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: { stdout: (s: string) => out.push(s), stderr: (s: string) => err.push(s) },
  };
};

describe('qsr opt-out', () => {
  it('stops probing and keeps the history: the request does not ask for it to be hidden', async () => {
    const { api, posts } = fakeApi();
    const c = io();
    const code = await optOutCommand(['acme-node'], recordingLogger(), c.io, api);
    expect(code).toBe(0);
    expect(posts).toEqual([
      { path: '/admin/tools/acme-node/opt-out', body: { hideHistory: false } },
    ]);
    const text = c.out.join('');
    expect(text).toContain('acme-node');
    expect(text).toContain(OPT_OUT.pageLabel);
    expect(text).toMatch(/past results stay visible/i);
  });

  it('--hide-history also hides the past results, and says so', async () => {
    const { api, posts } = fakeApi(answer({ historyHidden: true }));
    const c = io();
    expect(await optOutCommand(['acme-node', '--hide-history'], recordingLogger(), c.io, api)).toBe(
      0,
    );
    expect(posts[0]?.body).toEqual({ hideHistory: true });
    expect(c.out.join('')).toMatch(/past results are hidden/i);
  });

  it('needs exactly one slug, and refuses anything that is not a slug', async () => {
    for (const argv of [[], ['a-node', 'b-node'], ['../etc'], ['Acme Node']]) {
      const { api, posts } = fakeApi();
      const c = io();
      expect(await optOutCommand(argv, recordingLogger(), c.io, api)).toBe(2);
      expect(posts).toEqual([]);
      expect(c.err.join('')).toMatch(/slug/i);
    }
  });

  it('needs the API address and the admin token, and names the missing one (never a value)', async () => {
    const c = io();
    const saved = { a: process.env['API_BASE_URL'], t: process.env['ADMIN_TOKEN'] };
    delete process.env['API_BASE_URL'];
    delete process.env['ADMIN_TOKEN'];
    try {
      expect(await optOutCommand(['acme-node'], recordingLogger(), c.io)).toBe(2);
    } finally {
      if (saved.a !== undefined) process.env['API_BASE_URL'] = saved.a;
      if (saved.t !== undefined) process.env['ADMIN_TOKEN'] = saved.t;
    }
    expect(c.err.join('')).toContain('API_BASE_URL');
  });

  it('reports an API error and exits 1', async () => {
    const { api } = fakeApi(answer(), new Error('No such tool.'));
    const c = io();
    expect(await optOutCommand(['nope-node'], recordingLogger(), c.io, api)).toBe(1);
    expect(c.err.join('')).toContain('No such tool.');
  });
});

describe('qsr hide-history', () => {
  it('hides the past results of a tool that opted out, on its own request', async () => {
    const { api, posts } = fakeApi(answer({ historyHidden: true }));
    const c = io();
    expect(await hideHistoryCommand(['acme-node'], recordingLogger(), c.io, api)).toBe(0);
    expect(posts).toEqual([{ path: '/admin/tools/acme-node/hide-history', body: {} }]);
    expect(c.out.join('')).toMatch(/past results are hidden/i);
  });

  it('needs exactly one slug', async () => {
    const { api, posts } = fakeApi();
    const c = io();
    expect(await hideHistoryCommand([], recordingLogger(), c.io, api)).toBe(2);
    expect(posts).toEqual([]);
  });
});
