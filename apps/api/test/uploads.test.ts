import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { PUBLIC_BUCKET } from '../src/storage.js';
import { logPathFor, runPathPrefix } from '../src/log-paths.js';
import { resetDb, startTestApp, targetInput, type TestApp } from './helpers.js';

// POST /internal/uploads (spec section 11): signed upload URLs for a run's log files. Runners never get the
// service key. Paths are unguessable (cycle ids are public in the views) and reproducible by the server, so
// /internal/runs can re-validate that a path belongs to the run.

const dbUrl = inject('testDatabaseUrl');
const d = describe.skipIf(dbUrl === null);

let t: TestApp;
beforeAll(async () => {
  t = await startTestApp(dbUrl as string);
});
afterAll(async () => {
  await t?.close();
});
beforeEach(async () => {
  await resetDb(t.handle);
  t.storage.signed.length = 0;
});

async function cycle() {
  await t.signed('/internal/targets/sync', { targets: [targetInput('acme-node')] });
  return (await t.signed('/internal/cycles', { trigger: 'manual', gitSha: 'abcdef1234567' })).json()
    .cycleId as string;
}
const upload = (cycleId: string, over: Record<string, unknown> = {}) =>
  t.signed('/internal/uploads', {
    cycleId,
    toolSlug: 'acme-node',
    attempt: 1,
    files: [
      { stepId: 's1', ordinal: 0 },
      { stepId: 'qsr-check-syntax', ordinal: 2 },
    ],
    ...over,
  });

d('log path helpers', () => {
  const secret = 'secret-0123456789abcdef';
  const id = '3f2b8c1e-6d0a-4c52-9a3e-1b2c3d4e5f60';

  it('are deterministic, unguessable without the secret, and specific to the run', () => {
    const a = logPathFor(secret, id, 'acme-node', 1, { stepId: 's1', ordinal: 0 });
    expect(a).toMatch(new RegExp(`^logs/${id}/acme-node-1-[0-9a-f]{24}/00-s1\\.log\\.gz$`));
    expect(logPathFor(secret, id, 'acme-node', 1, { stepId: 's1', ordinal: 0 })).toBe(a);
    expect(
      logPathFor('another-secret-0123456789', id, 'acme-node', 1, { stepId: 's1', ordinal: 0 }),
    ).not.toBe(a);
    expect(logPathFor(secret, id, 'acme-node', 2, { stepId: 's1', ordinal: 0 })).not.toBe(a);
    expect(logPathFor(secret, id, 'other-node', 1, { stepId: 's1', ordinal: 0 })).not.toBe(a);
    expect(runPathPrefix(secret, id, 'acme-node', 1)).toBe(a.slice(0, a.lastIndexOf('/') + 1));
  });
});

d('POST /internal/uploads', () => {
  it('returns a signed upload URL per file, at the path the ingest will expect', async () => {
    const cycleId = await cycle();
    const res = await upload(cycleId);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.bucket).toBe(PUBLIC_BUCKET);
    expect(body.files.map((f: { stepId: string }) => f.stepId)).toEqual(['s1', 'qsr-check-syntax']);
    expect(body.files[0]).toMatchObject({
      path: logPathFor(t.config.ingestHmacSecret, cycleId, 'acme-node', 1, {
        stepId: 's1',
        ordinal: 0,
      }),
      token: 'T',
    });
    expect(body.files[0].signedUrl).toContain('https://storage.test/public-artifacts/logs/');
    expect(t.storage.signed).toHaveLength(2);
    expect(t.storage.signed.every((s) => s.bucket === PUBLIC_BUCKET)).toBe(true);
  });

  it('asking twice (a retried report job) gives the same paths', async () => {
    const cycleId = await cycle();
    const a = (await upload(cycleId)).json();
    const b = (await upload(cycleId)).json();
    expect(b.files.map((f: { path: string }) => f.path)).toEqual(
      a.files.map((f: { path: string }) => f.path),
    );
  });

  it('never returns the service-role key or any credential', async () => {
    const cycleId = await cycle();
    const res = await upload(cycleId);
    expect(res.body).not.toMatch(/service|apikey|Bearer|eyJ/i);
  });

  it.each([
    ['a path-traversal step id', [{ stepId: '../../etc/passwd', ordinal: 0 }]],
    ['an empty step id', [{ stepId: '', ordinal: 0 }]],
    ['a step id with a slash', [{ stepId: 'a/b', ordinal: 0 }]],
    ['a step id with spaces', [{ stepId: 'a b', ordinal: 0 }]],
    ['an over-long step id', [{ stepId: 'x'.repeat(65), ordinal: 0 }]],
    [
      'a repeated step id',
      [
        { stepId: 's1', ordinal: 0 },
        { stepId: 's1', ordinal: 1 },
      ],
    ],
    ['no files', []],
    ['too many files', Array.from({ length: 65 }, (_, i) => ({ stepId: `s${i}`, ordinal: i }))],
  ])('rejects %s', async (_name, files) => {
    const cycleId = await cycle();
    const res = await upload(cycleId, { files });
    expect(res.statusCode).toBe(400);
    expect(t.storage.signed).toHaveLength(0);
  });

  it('404 for an unknown cycle or tool, 409 for a finished cycle', async () => {
    const cycleId = await cycle();
    expect((await upload('00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
    expect((await upload(cycleId, { toolSlug: 'nope-node' })).statusCode).toBe(404);
    await t.handle.sql`update probe_cycles set finished_at = now()`;
    expect((await upload(cycleId)).statusCode).toBe(409);
  });

  it('503 when Storage is not configured, 502 when Storage fails', async () => {
    const none = await startTestApp(dbUrl as string, { storage: null });
    await none.signed('/internal/targets/sync', { targets: [targetInput('acme-node')] });
    const c = (
      await none.signed('/internal/cycles', { trigger: 'manual', gitSha: 'abcdef1234567' })
    ).json().cycleId;
    const res = await none.signed('/internal/uploads', {
      cycleId: c,
      toolSlug: 'acme-node',
      attempt: 1,
      files: [{ stepId: 's1', ordinal: 0 }],
    });
    expect(res.statusCode).toBe(503);
    await none.close();

    const cycleId = await cycle();
    t.storage.createSignedUpload = async () => {
      throw new Error('storage exploded');
    };
    const failing = await upload(cycleId);
    expect(failing.statusCode).toBe(502);
    expect(failing.body).not.toContain('exploded');
  });
});
