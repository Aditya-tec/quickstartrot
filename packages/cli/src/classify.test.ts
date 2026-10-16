import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Logger } from '@qsr/core';
import type { ClassifierLlm } from '@qsr/classifier';
import { classifyCommand } from './classify.js';
import type { CliIo } from './commands.js';

const FIXTURES = fileURLToPath(new URL('../../classifier/fixtures', import.meta.url));
const quiet: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  const handle: CliIo = { stdout: (t) => void out.push(t), stderr: (t) => void err.push(t) };
  return { handle, out: () => out.join(''), err: () => err.join('') };
};

interface Fixture {
  runResult: { toolSlug: string; steps: { stepId: string; logFile: string | null }[] };
  logs: Record<string, string>;
}

/** Lays a classifier fixture out the way `qsr run --out` does: <slug>-1.json next to <slug>-1/NN-id.log. */
async function layOut(
  id: string,
  opts: { withLogs?: boolean; patch?: (r: Fixture['runResult']) => void } = {},
) {
  const fx = JSON.parse(await readFile(path.join(FIXTURES, `${id}.json`), 'utf8')) as Fixture;
  opts.patch?.(fx.runResult);
  const dir = await mkdtemp(path.join(tmpdir(), 'qsr-classify-'));
  const file = path.join(dir, `${fx.runResult.toolSlug}-1.json`);
  await writeFile(file, JSON.stringify(fx.runResult));
  if (opts.withLogs !== false) {
    for (const step of fx.runResult.steps) {
      if (!step.logFile) continue;
      await mkdir(path.dirname(path.join(dir, step.logFile)), { recursive: true });
      await writeFile(path.join(dir, step.logFile), fx.logs[step.stepId] ?? '');
    }
  }
  return { dir, file, slug: fx.runResult.toolSlug };
}

async function targetsDir(
  slug: string,
  over: { authErrorIsPass?: boolean; level?: number; language?: string } = {},
) {
  const dir = await mkdtemp(path.join(tmpdir(), 'qsr-classify-targets-'));
  await writeFile(
    path.join(dir, `${slug}.yaml`),
    [
      `slug: ${slug}`,
      'name: Fixture',
      'docsUrl: https://example.com/docs',
      `language: ${over.language ?? 'node'}`,
      `level: ${over.level ?? 3}`,
      'runtime:',
      '  image: ghcr.io/aditya-tec/qsr-node:22',
      'extract:',
      '  root: main',
      'expect:',
      `  authErrorIsPass: ${over.authErrorIsPass ?? false}`,
      '  timeoutSec: 300',
    ].join('\n'),
  );
  return dir;
}

const run = async (args: string[], over: { llm?: ClassifierLlm } = {}) => {
  const o = io();
  const code = await classifyCommand(args, quiet, o.handle, over);
  return { code, out: o.out(), err: o.err() };
};

describe('qsr classify', () => {
  it('prints the class, the rule id, the signature and the evidence line', async () => {
    const { file, slug } = await layOut('node-run-not-a-function');
    const { code, out } = await run([file, '--targets', await targetsDir(slug)]);
    expect(code).toBe(0);
    expect(out).toMatch(/^class:\s+API_DRIFT$/m);
    expect(out).toMatch(/^rule:\s+drift\.not_a_function$/m);
    expect(out).toMatch(/^signature:\s+[0-9a-f]{64}$/m);
    expect(out).toMatch(/^evidence:\s+TypeError: ms\.nonexistentFunction is not a function$/m);
    expect(out).toMatch(/^source:\s+rule$/m);
  });

  it('a passing run has nothing to classify', async () => {
    const { file, slug } = await layOut('node-run-not-a-function', {
      patch: (r) => Object.assign(r, { outcome: 'PASS', failedStepId: null }),
    });
    const { code, out } = await run([file, '--targets', await targetsDir(slug)]);
    expect(code).toBe(0);
    expect(out).toContain('nothing to classify');
    expect(out).not.toMatch(/^class:/m);
  });

  it('--json prints the classification as JSON (null for a pass)', async () => {
    const { file, slug } = await layOut('node-run-not-a-function');
    const { out } = await run([file, '--json', '--targets', await targetsDir(slug)]);
    expect(JSON.parse(out)).toMatchObject({
      tool: slug,
      outcome: 'FAIL',
      classification: { failureClass: 'API_DRIFT', ruleId: 'drift.not_a_function', source: 'rule' },
    });
    const pass = await layOut('node-run-not-a-function', {
      patch: (r) => Object.assign(r, { outcome: 'PASS', failedStepId: null }),
    });
    const passed = await run([pass.file, '--json', '--targets', await targetsDir(pass.slug)]);
    expect(JSON.parse(passed.out)).toMatchObject({ outcome: 'PASS', classification: null });
  });

  it('reads the target: an auth error is NEEDS_CREDENTIALS only when auth errors are not a pass', async () => {
    const { file, slug } = await layOut('node-run-auth-401');
    const strict = await run([
      file,
      '--targets',
      await targetsDir(slug, { authErrorIsPass: false }),
    ]);
    expect(strict.out).toMatch(/^class:\s+NEEDS_CREDENTIALS$/m);
    expect(strict.out).toMatch(/^rule:\s+credentials\.auth_error$/m);
    const lenient = await run([
      file,
      '--targets',
      await targetsDir(slug, { authErrorIsPass: true }),
    ]);
    expect(lenient.out).toMatch(/^class:\s+UNKNOWN$/m);
    expect(lenient.out).toMatch(/^rule:\s+none$/m);
  });

  it('a level below 3 never grants auth-error-as-pass, whatever the target file says', async () => {
    const { file, slug } = await layOut('node-run-auth-401');
    const { out } = await run([
      file,
      '--targets',
      await targetsDir(slug, { authErrorIsPass: true, level: 2 }),
    ]);
    expect(out).toMatch(/^class:\s+NEEDS_CREDENTIALS$/m);
  });

  it('classifies from the stored tails when the log files are not next to the result', async () => {
    const { file, slug } = await layOut('node-run-not-a-function', { withLogs: false });
    const { code, out } = await run([file, '--targets', await targetsDir(slug)]);
    expect(code).toBe(0);
    expect(out).toMatch(/^rule:\s+drift\.not_a_function$/m);
  });

  it('a skipped run (manual step) is NEEDS_CREDENTIALS', async () => {
    const { file, slug } = await layOut('node-skipped-manual-step');
    const { out } = await run([file, '--targets', await targetsDir(slug)]);
    expect(out).toMatch(/^class:\s+NEEDS_CREDENTIALS$/m);
    expect(out).toMatch(/^rule:\s+skipped\.manual_step$/m);
  });

  it("with --llm a failure no rule matches goes to the injected model, and its answer is shown as the LLM's", async () => {
    const { file, slug } = await layOut('node-unknown-silent-failure', {
      patch: (r) => {
        const step = r.steps.find((s) => s.stepId === 's3') as { stderrTail?: string } | undefined;
        if (step) step.stderrTail = 'widget refused: protocol v2 required';
      },
    });
    const llm: ClassifierLlm = {
      complete: async () => ({
        content: JSON.stringify({
          class: 'API_DRIFT',
          confidence: 0.9,
          evidenceLine: 'widget refused: protocol v2 required',
        }),
      }),
    };
    const without = await run([file, '--targets', await targetsDir(slug)], { llm });
    expect(without.out).toMatch(/^class:\s+UNKNOWN$/m);
    const withLlm = await run([file, '--llm', '--targets', await targetsDir(slug)], { llm });
    expect(withLlm.out).toMatch(/^class:\s+API_DRIFT$/m);
    expect(withLlm.out).toMatch(/^rule:\s+llm\.fallback$/m);
    expect(withLlm.out).toMatch(/^source:\s+llm \(confidence 0\.9, listed for review\)$/m);
  });

  it('--llm without a GROQ_API_KEY and no injected client says so instead of crashing', async () => {
    const saved = process.env['GROQ_API_KEY'];
    delete process.env['GROQ_API_KEY'];
    try {
      const { file, slug } = await layOut('node-unknown-silent-failure');
      const { code, err } = await run([file, '--llm', '--targets', await targetsDir(slug)]);
      expect(code).toBe(2);
      expect(err).toContain('GROQ_API_KEY');
    } finally {
      if (saved !== undefined) process.env['GROQ_API_KEY'] = saved;
    }
  });

  describe('bad input is a usage error (exit 2), not a crash', () => {
    it('no file', async () => {
      const { code, err } = await run([]);
      expect(code).toBe(2);
      expect(err).toContain('missing <run-result.json>');
    });

    it('a file that does not exist', async () => {
      const { code, err } = await run(['/definitely/not/here.json']);
      expect(code).toBe(2);
      expect(err).toContain('cannot read');
    });

    it('a file that is not JSON, or not a RunResult', async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'qsr-classify-bad-'));
      const notJson = path.join(dir, 'a.json');
      const notResult = path.join(dir, 'b.json');
      await writeFile(notJson, '{nope');
      await writeFile(notResult, '{"hello":"world"}');
      expect((await run([notJson])).err).toContain('not valid JSON');
      const r = await run([notResult]);
      expect(r.code).toBe(2);
      expect(r.err).toContain('not a RunResult');
    });

    it('a result whose target is unknown', async () => {
      const { file } = await layOut('node-run-not-a-function');
      const empty = await mkdtemp(path.join(tmpdir(), 'qsr-classify-notargets-'));
      const { code, err } = await run([file, '--targets', empty]);
      expect(code).toBe(2);
      expect(err).toContain('fixture-node');
    });
  });
});
