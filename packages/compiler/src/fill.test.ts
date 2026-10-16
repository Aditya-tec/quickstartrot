import { describe, expect, it } from 'vitest';
import { fillFileContent } from './fill.js';
import {
  append,
  ctx,
  env,
  INDEX_TS,
  manual,
  plan,
  sh,
  write,
} from './grounding/fixtures.test-utils.js';
import { validateGrounding } from './grounding/index.js';

describe('fillFileContent: the model cites lines, the harness supplies the text', () => {
  it('replaces whatever the model wrote with the cited lines, placeholders applied', () => {
    const ir = plan([
      write('s1', 'index.ts', '', 6, 1, 4),
      write('s2', 'index.ts', 'totally different text', 6, 1, 4),
      append('s3', 'helper.ts', 'export const nope = 0;', 23, 1, 1),
    ]);
    const out = fillFileContent(ir, ctx());
    expect(out.steps[0]).toMatchObject({ content: INDEX_TS });
    expect(out.steps[1]).toMatchObject({ content: INDEX_TS });
    expect(out.steps[2]).toMatchObject({ content: 'export const helper = 2;' });
  });

  it('copies exactly, so a character the model would have dropped is present', () => {
    const c = ctx({
      blocks: [
        {
          index: 0,
          kind: 'code',
          lang: 'python',
          text: 'a = {\n    "k": 1,\n}',
          filenameHint: 'main.py',
          headingPath: [],
        },
      ],
      language: 'python',
    });
    const dropped = plan([write('s1', 'main.py', 'a = {\n    "k": 1\n}', 0, 1, 3)], {
      language: 'python',
    });
    const filled = fillFileContent(dropped, c);
    expect(filled.steps[0]).toMatchObject({ content: 'a = {\n    "k": 1,\n}' });
    expect(validateGrounding(filled, c).ok).toBe(true);
    expect(validateGrounding(dropped, c).ok).toBe(false);
  });

  it('copies only the cited range', () => {
    const out = fillFileContent(plan([write('s1', 'index.ts', '', 6, 3, 4)]), ctx());
    expect(out.steps[0]).toMatchObject({
      content:
        "const client = new Acme('qsr_dummy_key');\nawait client.send({ to: 'dev@example.com' });",
    });
  });

  it.each([
    ['a block that does not exist', 99, 1, 1],
    ['a range that does not exist', 6, 1, 99],
    ['a prose block', 5, 1, 1],
  ])(
    'leaves the step alone for %s, so validation reports the bad citation',
    (_name, block, start, end) => {
      const original = write('s1', 'index.ts', 'model text', block, start, end);
      expect(fillFileContent(plan([original]), ctx()).steps[0]).toEqual(original);
    },
  );

  it('leaves commands, env and manual steps untouched and does not mutate its input', () => {
    const steps = [
      sh('s1', 'npm install acme-sdk', 3, 1),
      env('s2', 'PORT', '3000'),
      manual('s3', 'x', 2, 1),
    ];
    const ir = plan([...steps, write('s4', 'index.ts', 'model text', 6, 1, 4)]);
    const out = fillFileContent(ir, ctx());
    expect(out.steps.slice(0, 3)).toEqual(steps);
    expect(ir.steps[3]).toMatchObject({ content: 'model text' });
  });
});
