import { describe, expect, it } from 'vitest';
import { describeStep } from './step-label';

// A run's steps are the plan's steps plus the checks the harness adds itself (the L2 syntax and import checks).
// Each needs a plain-language label.

const source = { blockIndex: 0, lineStart: 1, lineEnd: 1 };
const expect0 = { exitCode: 0, authErrorIsPass: false, stdoutIncludes: [], timeoutSec: 180 };

describe('describeStep', () => {
  it('labels the plan steps by their kind', () => {
    expect(
      describeStep(
        { step_id: 's1', kind: 'shell' },
        { kind: 'shell', id: 's1', command: 'npm install x', source, expect: expect0 },
      ),
    ).toEqual({
      what: 'Shell command',
      code: 'npm install x',
    });
    expect(
      describeStep(
        { step_id: 's2', kind: 'run' },
        { kind: 'run', id: 's2', command: 'node index.js', source, expect: expect0 },
      ),
    ).toEqual({
      what: 'Run the snippet',
      code: 'node index.js',
    });
    expect(
      describeStep(
        { step_id: 's3', kind: 'write_file' },
        { kind: 'write_file', id: 's3', path: 'index.js', content: '', source },
      ),
    ).toEqual({
      what: 'Write file',
      code: 'index.js',
    });
    expect(
      describeStep(
        { step_id: 's4', kind: 'manual' },
        { kind: 'manual', id: 's4', reason: 'Sign up', source },
      ),
    ).toEqual({
      what: 'Needs a person',
      code: 'Sign up',
    });
  });

  it('labels the harness checks that prove level 2', () => {
    expect(describeStep({ step_id: 'qsr-check-syntax', kind: 'harness_check' }, undefined)).toEqual(
      {
        what: 'Check: the code parses',
        code: null,
      },
    );
    expect(
      describeStep({ step_id: 'qsr-check-imports', kind: 'harness_check' }, undefined),
    ).toEqual({
      what: 'Check: its imports resolve',
      code: null,
    });
  });

  it('has a neutral label for a harness check or a step it does not know', () => {
    expect(
      describeStep({ step_id: 'qsr-check-other', kind: 'harness_check' }, undefined).what,
    ).toBe('Harness check');
    expect(describeStep({ step_id: 'x', kind: 'something_new' }, undefined).what).toBe('Step');
  });

  it('never shows a dummy environment value, only the variable name', () => {
    const d = describeStep(
      { step_id: 's', kind: 'set_env' },
      { kind: 'set_env', id: 's', name: 'API_KEY', value: 'sk-dummy', source: null },
    );
    expect(d).toEqual({ what: 'Set a dummy environment variable', code: 'API_KEY' });
  });
});
