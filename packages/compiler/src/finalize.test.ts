import { describe, expect, it } from 'vitest';
import type { Step } from '@qsr/core';
import { finalizePlan } from './finalize.js';
import { plan, run, sh, write } from './grounding/fixtures.test-utils.js';
import type { Truncation } from '@qsr/core';
import { target } from './scripted-llm.test-utils.js';

const loose = { exitCode: 3, authErrorIsPass: true, stdoutIncludes: ['x'], timeoutSec: 600 };
/** A command step whose expectations are as loose as a careless model could make them. */
const withLooseExpect = (s: Step, expect = loose): Step =>
  s.kind === 'shell' || s.kind === 'run' ? { ...s, expect } : s;

describe('finalizePlan: expectations belong to the harness and the target', () => {
  it('resets exit code and output assertions on every shell and run step', () => {
    const ir = plan([
      withLooseExpect(sh('s1', 'npm i x', 3, 1)),
      withLooseExpect(run('s2', 'node index.js')),
    ]);
    const out = finalizePlan(
      ir,
      target({ level: 3, expect: { authErrorIsPass: false, timeoutSec: 300 } }),
    );
    for (const s of out.steps) {
      expect(s).toMatchObject({
        expect: { exitCode: 0, stdoutIncludes: [], authErrorIsPass: false },
      });
    }
  });

  it('grants auth-error-as-pass only to run steps, only when the target asks, only at level 3+', () => {
    const ir = plan([sh('s1', 'npm i x', 3, 1), run('s2', 'node index.js')]);
    const pick = (t: ReturnType<typeof target>) =>
      finalizePlan(ir, t).steps.map((s) =>
        s.kind === 'shell' || s.kind === 'run' ? s.expect.authErrorIsPass : null,
      );
    expect(pick(target({ level: 3, expect: { authErrorIsPass: true, timeoutSec: 300 } }))).toEqual([
      false,
      true,
    ]);
    expect(pick(target({ level: 2, expect: { authErrorIsPass: true, timeoutSec: 300 } }))).toEqual([
      false,
      false,
    ]);
    expect(pick(target({ level: 3, expect: { authErrorIsPass: false, timeoutSec: 300 } }))).toEqual(
      [false, false],
    );
  });

  it('caps timeouts at the target value but keeps smaller ones', () => {
    const small = withLooseExpect(sh('s1', 'npm i x', 3, 1), { ...loose, timeoutSec: 20 });
    const big = withLooseExpect(sh('s2', 'npm i y', 3, 1), { ...loose, timeoutSec: 500 });
    const out = finalizePlan(
      plan([small, big]),
      target({ expect: { authErrorIsPass: false, timeoutSec: 120 } }),
    );
    expect(out.steps.map((s) => (s.kind === 'shell' ? s.expect.timeoutSec : null))).toEqual([
      20, 120,
    ]);
  });

  it('leaves file, env and manual steps untouched', () => {
    const ir = plan([write('s1', 'index.ts', 'x', 6, 1, 1)]);
    expect(finalizePlan(ir, target()).steps).toEqual(ir.steps);
  });

  it('does not mutate its input', () => {
    const ir = plan([withLooseExpect(sh('s1', 'npm i x', 3, 1))]);
    finalizePlan(ir, target());
    expect(ir.steps[0]).toMatchObject({ expect: loose });
  });
});

describe('finalizePlan: level and project setup', () => {
  it('never claims a higher level than the target asserts', () => {
    expect(
      finalizePlan(plan([], { maxLevelReachable: 4 }), target({ level: 2 })).maxLevelReachable,
    ).toBe(2);
    expect(
      finalizePlan(plan([], { maxLevelReachable: 1 }), target({ level: 3 })).maxLevelReachable,
    ).toBe(1);
  });

  it('uses the harness project setup for the language', () => {
    expect(finalizePlan(plan([], { projectInit: 'none' }), target()).projectInit).toBe('npm_init');
    expect(
      finalizePlan(
        plan([], { projectInit: 'none', language: 'python' }),
        target({ language: 'python' }),
      ).projectInit,
    ).toBe('python_venv');
  });

  it.each([
    ['npm init -y', 'node'],
    ['  pnpm init', 'node'],
    ['yarn init -y', 'node'],
  ])('node: %s means the docs create their own project', (command) => {
    expect(finalizePlan(plan([sh('s1', command, 3, 1)]), target()).projectInit).toBe('none');
  });

  it('node: writing package.json means the docs own the project', () => {
    expect(
      finalizePlan(plan([write('s1', './package.json', '{}', 17, 1, 1)]), target()).projectInit,
    ).toBe('none');
    expect(
      finalizePlan(plan([write('s1', 'package.json', '{}', 17, 1, 1)]), target()).projectInit,
    ).toBe('none');
    expect(
      finalizePlan(plan([write('s1', 'src/package.json', '{}', 17, 1, 1)]), target()).projectInit,
    ).toBe('npm_init');
  });

  it('python: a venv command means the docs own the environment, other commands do not', () => {
    const py = target({ language: 'python' });
    expect(
      finalizePlan(plan([sh('s1', 'python -m venv .venv', 3, 1)], { language: 'python' }), py)
        .projectInit,
    ).toBe('none');
    expect(
      finalizePlan(plan([sh('s1', 'virtualenv env', 3, 1)], { language: 'python' }), py)
        .projectInit,
    ).toBe('none');
    expect(
      finalizePlan(plan([sh('s1', 'pip install x', 3, 1)], { language: 'python' }), py).projectInit,
    ).toBe('python_venv');
    expect(
      finalizePlan(plan([write('s1', 'package.json', '{}', 17, 1, 1)], { language: 'python' }), py)
        .projectInit,
    ).toBe('python_venv');
  });
});

describe('finalizePlan: a truncated page cannot claim more than L2', () => {
  const truncated: Truncation = {
    truncated: true,
    totalBlocks: 65,
    includedBlocks: 32,
    omittedBlocks: 33,
    omittedBlockIndexes: [32, 33],
    clippedBlockIndexes: [],
  };
  const complete: Truncation = {
    truncated: false,
    totalBlocks: 3,
    includedBlocks: 3,
    omittedBlocks: 0,
    omittedBlockIndexes: [],
    clippedBlockIndexes: [],
  };
  const t3 = target({ level: 3 });
  const full = [
    sh('s1', 'npm install acme', 3, 1),
    write('s2', 'index.js', 'x', 6, 1, 1),
    run('s3', 'node index.js'),
  ];

  it('caps at 2 when the included blocks give no install, no file write and no run', () => {
    const noRun = plan([sh('s1', 'npm install acme', 3, 1), write('s2', 'index.js', 'x', 6, 1, 1)]);
    expect(finalizePlan({ ...noRun, maxLevelReachable: 3 }, t3, truncated).maxLevelReachable).toBe(
      2,
    );
    const noInstall = plan([write('s2', 'index.js', 'x', 6, 1, 1), run('s3', 'node index.js')]);
    expect(finalizePlan(noInstall, t3, truncated).maxLevelReachable).toBe(2);
    const noWrite = plan([sh('s1', 'npm install acme', 3, 1), run('s3', 'node index.js')]);
    expect(finalizePlan(noWrite, t3, truncated).maxLevelReachable).toBe(2);
    const onlyEcho = plan([
      sh('s1', 'echo hi', 3, 1),
      write('s2', 'a.js', 'x', 6, 1, 1),
      run('s3', 'node a.js'),
    ]);
    expect(finalizePlan(onlyEcho, t3, truncated).maxLevelReachable).toBe(2);
  });

  it('keeps L3 when the included blocks do give an install, a file write and a run step', () => {
    expect(finalizePlan(plan(full), t3, truncated).maxLevelReachable).toBe(3);
    const withAppend = plan([
      sh('s1', 'pip install acme', 3, 1),
      {
        kind: 'append_file',
        id: 's2',
        path: 'm.py',
        content: 'x',
        source: { blockIndex: 6, lineStart: 1, lineEnd: 1 },
      },
      run('s3', 'python m.py'),
    ]);
    expect(finalizePlan(withAppend, t3, truncated).maxLevelReachable).toBe(3);
  });

  it('never raises a level the model or the target already set lower', () => {
    expect(
      finalizePlan(plan(full, { maxLevelReachable: 1 }), t3, truncated).maxLevelReachable,
    ).toBe(1);
    expect(
      finalizePlan(plan([], { maxLevelReachable: 4 }), target({ level: 2 }), truncated)
        .maxLevelReachable,
    ).toBe(2);
  });

  it('does nothing for a complete page, or when no truncation is given', () => {
    const noRun = plan([sh('s1', 'npm install acme', 3, 1)], { maxLevelReachable: 3 });
    expect(finalizePlan(noRun, t3, complete).maxLevelReachable).toBe(3);
    expect(finalizePlan(noRun, t3).maxLevelReachable).toBe(3);
  });

  it('a clipped block counts as truncation even when no block was omitted', () => {
    const clipped: Truncation = { ...complete, truncated: true, clippedBlockIndexes: [0] };
    const noRun = plan([sh('s1', 'npm install acme', 3, 1)], { maxLevelReachable: 3 });
    expect(finalizePlan(noRun, t3, clipped).maxLevelReachable).toBe(2);
  });
});
