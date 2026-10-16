import { describe, expect, it } from 'vitest';
import { quarantineDestructive, validateGrounding } from './index.js';
import {
  append,
  ctx,
  env,
  INDEX_TS,
  manual,
  plan,
  run,
  sh,
  src,
  write,
} from './fixtures.test-utils.js';

// Edge cases that complete the coverage of the validator and pin down the less obvious rules.

describe('details and provenance edges', () => {
  it('truncates long text in violation details', () => {
    const long = `npm install ${'x'.repeat(300)}`;
    const r = validateGrounding(plan([sh('s1', long, 3, 1)]), ctx());
    const detail = r.violations.find((v) => v.rule === 'command.mismatch')?.detail ?? '';
    expect(detail).toContain('...');
    expect(detail.length).toBeLessThan(250);
  });

  it('grounds a file name through the first line of the code block (comment convention)', () => {
    const c = ctx({
      blocks: [
        {
          index: 0,
          kind: 'code',
          lang: 'js',
          text: '// server.mjs\nconsole.log(1);',
          filenameHint: null,
          headingPath: [],
        },
      ],
    });
    const named = plan([write('s1', 'server.mjs', '// server.mjs\nconsole.log(1);', 0, 1, 2)]);
    expect(validateGrounding(named, c).ok).toBe(true);
    const other = plan([write('s1', 'other.mjs', '// server.mjs\nconsole.log(1);', 0, 1, 2)]);
    expect(validateGrounding(other, c).violations.map((v) => v.rule)).toEqual([
      'file.path_ungrounded',
    ]);
  });

  it('reports an unsourced run whose command is malformed before any file is written', () => {
    const r = validateGrounding(plan([run('s1', 'node')]), ctx());
    expect(r.violations.map((v) => v.rule)).toEqual(['run.not_allowlisted']);
  });

  it('a sourced env step may cite any code block, and appends count as writing the file', () => {
    const steps = [
      append('s1', 'index.ts', 'export const a = 1;', 18, 1, 1),
      run('s2', 'node index.ts'),
      env('s3', 'PORT', '3000', src(13, 2)),
    ];
    expect(validateGrounding(plan(steps), ctx()).violations).toEqual([]);
  });
});

describe('violation messages are specific enough for the model to fix its own mistake', () => {
  it('file.content_mismatch names the first differing line and both versions', () => {
    // The real-world failure: a trailing comma dropped while copying a file.
    const c = ctx({
      blocks: [
        {
          index: 0,
          kind: 'code',
          lang: 'python',
          text: 'a = {\n    "k": 1,\n}\nprint(a)',
          filenameHint: 'main.py',
          headingPath: [],
        },
      ],
      language: 'python',
    });
    const dropped = 'a = {\n    "k": 1\n}\nprint(a)';
    const r = validateGrounding(
      plan([write('s1', 'main.py', dropped, 0, 1, 4)], { language: 'python' }),
      c,
    );
    const detail = r.violations.find((v) => v.rule === 'file.content_mismatch')?.detail ?? '';
    expect(detail).toContain('first difference at line 2');
    expect(detail).toContain('docs have "    \\"k\\": 1,"');
    expect(detail).toContain('yours has "    \\"k\\": 1"');
  });

  it('says so when the model stopped early or ran on', () => {
    const c = ctx({
      blocks: [
        {
          index: 0,
          kind: 'code',
          lang: 'ini',
          text: 'a=1\nb=2',
          filenameHint: 'a.ini',
          headingPath: [],
        },
      ],
    });
    const short = validateGrounding(plan([write('s1', 'a.ini', 'a=1', 0, 1, 2)]), c);
    expect(short.violations[0]?.detail).toContain('yours has nothing (the content ends)');
    const long = validateGrounding(plan([write('s1', 'a.ini', 'a=1\nb=2\nc=3', 0, 1, 2)]), c);
    expect(long.violations[0]?.detail).toContain('docs have nothing (the cited lines end)');
  });

  it('file.path_ungrounded tells the model which name it may use', () => {
    // Real failures: "app.py" and "example.py" invented where the docs name no file.
    const py = ctx({ language: 'python' });
    const noHint = validateGrounding(
      plan([write('s1', 'app.py', 'def f():\n    return 1\n\nprint(f())', 20, 1, 4)], {
        language: 'python',
      }),
      py,
    );
    expect(noHint.violations[0]?.detail).toContain(
      'the docs name no file here; use exactly main.py',
    );
    const node = validateGrounding(
      plan([write('s1', 'server.js', 'export const a = 1;', 18, 1, 1)]),
      ctx(),
    );
    expect(node.violations[0]?.detail).toContain('use exactly index.js or index.ts');
    const hinted = validateGrounding(plan([write('s1', 'server.ts', INDEX_TS, 6, 1, 4)]), ctx());
    expect(hinted.violations[0]?.detail).toContain('the docs name this file index.ts');
  });

  it('command.mismatch points at set_env when the cited line is a variable assignment', () => {
    // Real failure: "export RESEND_API_KEY=..." emitted as a shell step.
    const r = validateGrounding(plan([sh('s1', 'ACME_API_KEY=qsr_dummy_key', 13, 1)]), ctx());
    expect(r.violations.find((v) => v.rule === 'command.mismatch')?.detail).toContain(
      'use a set_env step',
    );
    const plain = validateGrounding(plan([sh('s1', 'npm i x', 3, 1)]), ctx());
    expect(plain.violations.find((v) => v.rule === 'command.mismatch')?.detail).not.toContain(
      'set_env',
    );
  });

  it('run.file_not_written says which files were written and how to fix the plan', () => {
    // Real failure: the model cited a README line "python <your_file>.py" as the run command.
    const none = validateGrounding(
      plan([run('s1', 'python main.py')], { language: 'python' }),
      ctx({ language: 'python' }),
    );
    const noneDetail = none.violations.find((v) => v.rule === 'run.file_not_written')?.detail ?? '';
    expect(noneDetail).toContain('no file has been written yet');
    expect(noneDetail).toContain('python <file>');

    const some = validateGrounding(
      plan(
        [
          write('s1', 'main.py', 'import acme\nacme.send()', 14, 1, 2),
          run('s2', 'python <your_file>.py'),
        ],
        { language: 'python' },
      ),
      ctx({ language: 'python' }),
    );
    const someDetail = some.violations.find((v) => v.rule === 'run.file_not_written')?.detail ?? '';
    expect(someDetail).toContain('files written so far: main.py');
  });

  it('command.mismatch shows what the cited lines actually say', () => {
    const r = validateGrounding(plan([sh('s1', 'npm i acme-sdk', 3, 1)]), ctx());
    const detail = r.violations.find((v) => v.rule === 'command.mismatch')?.detail ?? '';
    expect(detail).toContain('the cited lines read "npm install acme-sdk"');
  });
});

describe('quarantineDestructive edges', () => {
  const notes = (n: string) =>
    plan([sh('s1', 'sudo npm install -g acme-cli', 10, 1)], { notes: n });

  it('appends to existing notes instead of replacing them', () => {
    const { ir } = quarantineDestructive(notes('Used the default file name.'), ctx());
    expect(ir.notes.startsWith('Used the default file name. Replaced by manual steps')).toBe(true);
  });

  it('starts the notes when there were none', () => {
    const { ir } = quarantineDestructive(notes(''), ctx());
    expect(ir.notes.startsWith('Replaced by manual steps (denylist): s1:')).toBe(true);
  });

  it('only demotes steps that are actually destructive', () => {
    const steps = [
      env('s1', 'PORT', '3000', src(13, 2)),
      manual('s2', 'Sign up first', 2, 1),
      append('s3', 'index.ts', 'export const a = 1;', 18, 1, 1),
      write('s4', 'a\\b.ts', 'export const a = 1;', 18, 1, 1), // malformed, not destructive
      run('s5', 'npx tsx index.ts', src(8, 1)),
    ];
    const original = plan(steps);
    const out = quarantineDestructive(original, ctx());
    expect(out.quarantined).toEqual([]);
    expect(out.ir).toBe(original);
  });

  it('demotes an append_file that targets a path outside /work', () => {
    const c = ctx({
      blocks: [
        { index: 0, kind: 'code', lang: 'ini', text: 'a=1', filenameHint: null, headingPath: [] },
      ],
    });
    const out = quarantineDestructive(plan([append('s1', '/etc/app.conf', 'a=1', 0, 1, 1)]), c);
    expect(out.quarantined).toEqual(['s1']);
    expect(out.ir.steps[0]).toMatchObject({ kind: 'manual', id: 's1' });
  });
});
