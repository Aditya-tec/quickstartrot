import type { GroundingReport, Step } from '@qsr/core';
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

// Adversarial tests for the grounding validator (spec section 8): "the most important trust
// mechanism in the project". Written before the implementation. Each attack describes something a
// confused or prompt-injected LLM could emit; the validator must reject it deterministically.

const check = (steps: Step[], over: Parameters<typeof plan>[1] = {}, c = ctx()): GroundingReport =>
  validateGrounding(plan(steps, over), c);
const rules = (r: GroundingReport, stepId?: string): string[] =>
  r.violations.filter((v) => stepId === undefined || v.stepId === stepId).map((v) => v.rule);
const cp = (...points: number[]): string => String.fromCodePoint(...points);

describe('baseline: legitimate plans are accepted', () => {
  it('accepts verbatim commands, files, env, run and manual steps', () => {
    const r = check([
      sh('s1', 'npm install acme-sdk', 3, 1),
      sh('s2', 'npm install --save-dev typescript', 3, 2),
      write('s3', 'index.ts', INDEX_TS, 6, 1, 4),
      env('s4', 'ACME_API_KEY', 'qsr_dummy_key', src(13, 1)),
      run('s5', 'npx tsx index.ts', src(8, 1)),
      manual('s6', 'Needs a dashboard signup', 2, 1),
    ]);
    expect(r).toEqual({ ok: true, violations: [] });
  });

  it('accepts the docs form of a placeholder as well as the mapped form (map applied to both sides)', () => {
    const docsForm = INDEX_TS.replace('qsr_dummy_key', 'YOUR_API_KEY');
    expect(check([write('s1', 'index.ts', docsForm, 6, 1, 4)]).ok).toBe(true);
    expect(check([write('s1', 'index.ts', INDEX_TS, 6, 1, 4)]).ok).toBe(true);
  });

  it('accepts a placeholder whose replacement contains the placeholder text itself', () => {
    const c = ctx({ placeholders: { YOUR_API_KEY: 'YOUR_API_KEY_dummy' } });
    const content = INDEX_TS.replace('qsr_dummy_key', 'YOUR_API_KEY_dummy');
    expect(check([write('s1', 'index.ts', content, 6, 1, 4)], {}, c).ok).toBe(true);
  });

  it('accepts a command that is a whole segment of a && chain, but not a fragment of one', () => {
    for (const command of [
      'cd my-app',
      'npm install',
      'npm run dev',
      'cd my-app && npm install',
      'npm install && npm run dev',
    ]) {
      expect(check([sh('s1', command, 9, 1)]).ok, command).toBe(true);
    }
  });

  it('ignores whitespace differences outside quotes and across line continuations', () => {
    expect(check([sh('s1', '  npm   install   acme-sdk ', 3, 1)]).ok).toBe(true);
    expect(check([sh('s1', 'npm install acme-sdk', 16, 1, 2)]).ok).toBe(true);
  });

  it('accepts a run step without a source only for harness allowlist commands on a file already written', () => {
    expect(
      check([write('s1', 'index.ts', INDEX_TS, 6, 1, 4), run('s2', 'npx tsx index.ts')]).ok,
    ).toBe(true);
    expect(check([write('s1', 'index.ts', INDEX_TS, 6, 1, 4), run('s2', 'node index.ts')]).ok).toBe(
      true,
    );
    const py = ctx();
    expect(
      validateGrounding(
        plan(
          [
            write('s1', 'main.py', 'import acme\nacme.send()', 14, 1, 2),
            run('s2', 'python main.py'),
          ],
          { language: 'python' },
        ),
        { ...py, language: 'python' },
      ).ok,
    ).toBe(true);
  });

  it('accepts append_file continuing a file and files grounded by prose or by a hint', () => {
    const r = check([
      write('s1', 'index.ts', INDEX_TS, 6, 1, 4),
      append('s2', 'helper.ts', 'export const helper = 2;', 23, 1, 1), // named in prose block 22
      write('s3', 'package.json', '{ "name": "demo" }', 17, 1, 1), // filename hint
      write('s4', 'index.ts', 'export const a = 1;', 18, 1, 1), // no hint: language default
    ]);
    expect(r.violations).toEqual([]);
  });

  it('accepts set_env without a source only for a placeholder replacement whose name is in the docs', () => {
    expect(check([env('s1', 'ACME_API_KEY', 'qsr_dummy_key')]).ok).toBe(true);
  });

  it('accepts shell commands from untagged and plain-text blocks', () => {
    expect(check([sh('s1', 'node -e "console.log(1)"', 21, 1)]).ok).toBe(true);
    expect(check([sh('s1', 'queued', 19, 1)]).ok).toBe(true);
  });

  it('accepts a relative recursive rm inside /work (not destructive)', () => {
    expect(check([sh('s1', 'rm -rf node_modules && npm install', 12, 1)]).ok).toBe(true);
  });
});

describe('attack 1: invented import / package not in the docs', () => {
  it('rejects an extra import line in a written file', () => {
    const evil = INDEX_TS.replace(
      "import { Acme } from 'acme-sdk';",
      "import { Acme } from 'acme-sdk';\nimport { exfil } from 'evil-pkg';",
    );
    expect(rules(check([write('s1', 'index.ts', evil, 6, 1, 4)]), 's1')).toContain(
      'file.content_mismatch',
    );
  });

  it('rejects a package smuggled into an install command', () => {
    expect(rules(check([sh('s1', 'npm install acme-sdk evil-pkg', 3, 1)]), 's1')).toContain(
      'command.mismatch',
    );
  });

  it('rejects swapping the imported module for another', () => {
    const evil = INDEX_TS.replaceAll('acme-sdk', 'acme-sdk-fork');
    expect(check([write('s1', 'index.ts', evil, 6, 1, 4)]).ok).toBe(false);
  });
});

describe('attack 2: "fixed" or upgraded version numbers and truncated names', () => {
  it.each([
    'npm install acme-sdk@latest',
    'npm install acme-sdk@2.0.0',
    'npm install --save-dev typescript@5',
    'npm install acme-s',
    'npm install acme-sdk-',
    'npm i acme-sdk',
  ])('rejects %s', (command) => {
    expect(rules(check([sh('s1', command, 3, 1)]), 's1')).toContain('command.mismatch');
  });

  it('rejects a version bump inside file content', () => {
    const evil = INDEX_TS.replace('acme-sdk', 'acme-sdk@2');
    expect(check([write('s1', 'index.ts', evil, 6, 1, 4)]).ok).toBe(false);
  });
});

describe('attack 3: reordered or partial lines', () => {
  it('rejects a multi-line command with its lines reordered', () => {
    const reordered = 'npm install --save-dev typescript\nnpm install acme-sdk';
    expect(rules(check([sh('s1', reordered, 3, 1, 2)]), 's1')).toContain('command.mismatch');
  });

  it('rejects a multi-line command with a line dropped from the cited range', () => {
    expect(
      rules(check([sh('s1', 'npm install acme-sdk\nnpm run build', 3, 1, 2)]), 's1'),
    ).toContain('command.mismatch');
  });

  it('rejects file content that is only part of the cited lines', () => {
    const partial = INDEX_TS.split('\n').slice(0, 2).join('\n');
    expect(rules(check([write('s1', 'index.ts', partial, 6, 1, 4)]), 's1')).toContain(
      'file.content_mismatch',
    );
    const tail = INDEX_TS.split('\n').slice(2).join('\n');
    expect(rules(check([write('s1', 'index.ts', tail, 6, 1, 4)]), 's1')).toContain(
      'file.content_mismatch',
    );
  });

  it('rejects reordered file lines', () => {
    const lines = INDEX_TS.split('\n');
    const reordered = [lines[2], lines[0], lines[1], lines[3]].join('\n');
    expect(check([write('s1', 'index.ts', reordered, 6, 1, 4)]).ok).toBe(false);
  });

  it('rejects dedented Python (indentation is part of the program)', () => {
    const python = 'def f():\nreturn 1\n\nprint(f())';
    expect(
      rules(
        check(
          [write('s1', 'main.py', python, 20, 1, 4)],
          { language: 'python' },
          ctx({ language: 'python' }),
        ),
        's1',
      ),
    ).toContain('file.content_mismatch');
  });

  it('tolerates CRLF, trailing whitespace and surrounding blank lines in written files', () => {
    const noisy = `\n${INDEX_TS.split('\n').join('  \r\n')}  \n\n`;
    expect(check([write('s1', 'index.ts', noisy, 6, 1, 4)]).ok).toBe(true);
  });
});

describe('attack 4: hallucinated file paths and filenames', () => {
  it('rejects a path that contradicts the block filename hint', () => {
    expect(rules(check([write('s1', 'server.ts', INDEX_TS, 6, 1, 4)]), 's1')).toContain(
      'file.path_ungrounded',
    );
  });

  it('rejects the language default when the docs gave a different name', () => {
    expect(rules(check([write('s1', 'index.js', INDEX_TS, 6, 1, 4)]), 's1')).toContain(
      'file.path_ungrounded',
    );
  });

  it('rejects a filename mentioned nowhere in the docs', () => {
    expect(
      rules(check([write('s1', 'other.ts', 'export const helper = 2;', 23, 1, 1)]), 's1'),
    ).toContain('file.path_ungrounded');
    expect(
      rules(check([write('s1', 'config/evil.sh', 'export const a = 1;', 18, 1, 1)]), 's1'),
    ).toContain('file.path_ungrounded');
  });

  it('rejects a Python default that is not main.py', () => {
    const c = ctx({ language: 'python' });
    expect(
      rules(
        validateGrounding(
          plan([write('s1', 'app.py', 'def f():\n    return 1\n\nprint(f())', 20, 1, 4)], {
            language: 'python',
          }),
          c,
        ),
        's1',
      ),
    ).toContain('file.path_ungrounded');
  });

  it('rejects running a file that no earlier step wrote', () => {
    expect(rules(check([run('s1', 'node app.js')]), 's1')).toContain('run.file_not_written');
    // order matters: the write must come first
    expect(
      rules(check([run('s1', 'node index.ts'), write('s2', 'index.ts', INDEX_TS, 6, 1, 4)]), 's1'),
    ).toContain('run.file_not_written');
  });
});

describe('attack 5: one command stitched together from two blocks', () => {
  it('rejects a chain whose second half comes from another block', () => {
    expect(
      rules(check([sh('s1', 'npm install acme-sdk && npx tsx index.ts', 3, 1)]), 's1'),
    ).toContain('command.mismatch');
    expect(
      rules(check([sh('s1', 'npm install acme-sdk\nnpx tsx index.ts', 3, 1, 2)]), 's1'),
    ).toContain('command.mismatch');
  });

  it('rejects a command that sits in the neighbouring line rather than the cited one', () => {
    expect(rules(check([sh('s1', 'npm install --save-dev typescript', 3, 1)]), 's1')).toContain(
      'command.mismatch',
    );
  });

  it('rejects a fragment of a chain that starts or ends inside a quoted string', () => {
    expect(rules(check([sh('s1', 'rm -rf /tmp/x"', 15, 1)]), 's1')).toContain('command.mismatch');
    expect(check([sh('s1', 'echo "done; rm -rf /tmp/x"', 15, 1)]).ok).toBe(true);
  });

  it('rejects file content stitched from two blocks', () => {
    expect(check([write('s1', 'index.ts', `${INDEX_TS}\nexport const a = 1;`, 6, 1, 4)]).ok).toBe(
      false,
    );
  });
});

describe('attack 6: Unicode look-alikes and zero-width characters', () => {
  it('rejects a Cyrillic letter swapped into a package name', () => {
    const lookalike = `npm install ${cp(0x0430)}cme-sdk`; // Cyrillic small a
    expect(rules(check([sh('s1', lookalike, 3, 1)]), 's1')).toContain('command.mismatch');
  });

  it('rejects full-width characters (NFKC would fold them, so the validator must not)', () => {
    expect(check([sh('s1', `${cp(0xff4e)}pm install acme-sdk`, 3, 1)]).ok).toBe(false);
  });

  it.each([0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0x202e, 0x2066])(
    'flags U+%s as suspicious wherever it appears',
    (point) => {
      const hidden = cp(point);
      const bad: Step[] = [
        sh('c', `npm install acme${hidden}-sdk`, 3, 1),
        write('f', `index${hidden}.ts`, INDEX_TS, 6, 1, 4),
        write('g', 'index.ts', INDEX_TS.replace('Acme(', `Acme${hidden}(`), 6, 1, 4),
        env('e', 'ACME_API_KEY', `qsr${hidden}_dummy_key`),
        manual('m', `do this${hidden}`, 2, 1),
      ];
      for (const s of bad)
        expect(rules(check([s]), s.id), s.id).toContain('text.suspicious_characters');
    },
  );

  it('flags a hidden character even when the docs themselves contain it (defence in depth)', () => {
    const hidden = cp(0x200b);
    const text = `npm install acme${hidden}-sdk`;
    const c = ctx({
      blocks: [{ index: 0, kind: 'code', lang: 'bash', text, filenameHint: null, headingPath: [] }],
    });
    expect(rules(validateGrounding(plan([sh('s1', text, 0, 1)]), c), 's1')).toContain(
      'text.suspicious_characters',
    );
  });

  it('flags control characters other than newline and tab', () => {
    expect(rules(check([sh('s1', `npm install acme-sdk${cp(0x07)}`, 3, 1)]), 's1')).toContain(
      'text.suspicious_characters',
    );
    expect(rules(check([sh('s1', `npm install acme-sdk${cp(0x9b)}`, 3, 1)]), 's1')).toContain(
      'text.suspicious_characters',
    );
  });
});

describe('attack 7: destructive commands that appear verbatim in the docs', () => {
  it('rejects sudo and rm -rf / even though they are grounded, and the failure is the denylist not a mismatch', () => {
    const sudo = check([sh('s1', 'sudo npm install -g acme-cli', 10, 1)]);
    expect(rules(sudo, 's1')).toEqual(['denylist']);
    const rm = check([sh('s2', 'rm -rf /', 11, 1)]);
    expect(rules(rm, 's2')).toEqual(['denylist']);
  });

  it('rejects a file written outside /work even when the docs name that path', () => {
    const c = ctx({
      blocks: [
        {
          index: 0,
          kind: 'code',
          lang: 'ini',
          text: 'a=1',
          filenameHint: '/etc/app.conf',
          headingPath: [],
        },
      ],
    });
    expect(
      rules(validateGrounding(plan([write('s1', '/etc/app.conf', 'a=1', 0, 1, 1)]), c), 's1'),
    ).toContain('denylist');
  });

  it('quarantine turns a grounded destructive step into a manual step and notes it', () => {
    const original = plan([
      sh('s1', 'npm install acme-sdk', 3, 1),
      sh('s2', 'sudo npm install -g acme-cli', 10, 1),
      sh('s3', 'npm install --save-dev typescript', 3, 2),
    ]);
    const { ir, quarantined } = quarantineDestructive(original, ctx());
    expect(quarantined).toEqual(['s2']);
    expect(ir.steps.map((s) => s.kind)).toEqual(['shell', 'manual', 'shell']);
    expect(ir.steps[1]).toMatchObject({ kind: 'manual', id: 's2', source: src(10, 1) });
    expect(ir.notes).toMatch(/s2/);
    expect(validateGrounding(ir, ctx()).ok).toBe(true);
    expect(original.steps[1]?.kind).toBe('shell'); // input is not mutated
  });

  it('quarantine leaves an ungrounded destructive step alone so the plan still fails validation', () => {
    const evil = plan([sh('s1', 'sudo rm -rf /', 3, 1)]);
    const { ir, quarantined } = quarantineDestructive(evil, ctx());
    expect(quarantined).toEqual(['s1']);
    expect(ir.steps[0]?.kind).toBe('manual'); // source is valid (block 3 line 1), so it is demoted
    const nowhere = plan([sh('s1', 'sudo rm -rf /', 99, 1)]);
    const out = quarantineDestructive(nowhere, ctx());
    expect(out.quarantined).toEqual([]);
    expect(out.ir.steps[0]?.kind).toBe('shell');
    expect(validateGrounding(out.ir, ctx()).ok).toBe(false);
  });

  it('quarantine demotes destructive file writes and leaves clean plans untouched', () => {
    const c = ctx({
      blocks: [
        {
          index: 0,
          kind: 'code',
          lang: 'ini',
          text: 'a=1',
          filenameHint: '/etc/app.conf',
          headingPath: [],
        },
      ],
    });
    const out = quarantineDestructive(plan([write('s1', '/etc/app.conf', 'a=1', 0, 1, 1)]), c);
    expect(out.ir.steps[0]?.kind).toBe('manual');
    const clean = plan([sh('s1', 'npm install acme-sdk', 3, 1)]);
    expect(quarantineDestructive(clean, ctx())).toEqual({ ir: clean, quarantined: [] });
  });
});

describe('attack 8: citations of blocks or lines that do not exist', () => {
  it('rejects a block index that is not in the extraction', () => {
    expect(rules(check([sh('s1', 'npm install acme-sdk', 99, 1)]), 's1')).toContain(
      'source.block_not_found',
    );
    expect(rules(check([manual('s1', 'x', 99, 1)]), 's1')).toContain('source.block_not_found');
  });

  it.each([
    [0, 1],
    [1, 3],
    [3, 2],
    [-1, 1],
    [2, 5],
  ])('rejects line range %i-%i on a 2-line block', (start, end) => {
    const r = check([sh('s1', 'npm install acme-sdk', 3, start, end)]);
    expect(rules(r, 's1')).toContain('source.range_invalid');
  });

  it('rejects citing prose or a heading as the source of a command or file', () => {
    expect(rules(check([sh('s1', 'Install the package from npm.', 2, 1)]), 's1')).toContain(
      'source.not_code',
    );
    expect(rules(check([write('s2', 'index.ts', 'x', 0, 1, 1)]), 's2')).toContain(
      'source.not_code',
    );
  });

  it('allows a manual step to cite prose', () => {
    expect(check([manual('s1', 'Sign up first', 2, 1)]).ok).toBe(true);
  });

  it('rejects a command cited from a block that is not shell-like (JSON, TypeScript)', () => {
    expect(rules(check([sh('s1', "import { Acme } from 'acme-sdk';", 6, 1)]), 's1')).toContain(
      'command.source_not_shell',
    );
    expect(rules(check([sh('s1', '{ "name": "demo" }', 17, 1)]), 's1')).toContain(
      'command.source_not_shell',
    );
  });
});

describe('attack 9: placeholders replaced with values that are not in the map', () => {
  it('rejects a real-looking secret in place of the placeholder in file content', () => {
    const evil = INDEX_TS.replace('qsr_dummy_key', 'sk_live_REAL_SECRET');
    expect(rules(check([write('s1', 'index.ts', evil, 6, 1, 4)]), 's1')).toContain(
      'file.content_mismatch',
    );
  });

  it('rejects an unsourced env var whose value is not a placeholder replacement', () => {
    expect(rules(check([env('s1', 'ACME_API_KEY', 'sk_live_REAL_SECRET')]), 's1')).toContain(
      'env.value_not_placeholder',
    );
  });

  it('rejects a sourced env var that differs from the cited assignment', () => {
    expect(rules(check([env('s1', 'ACME_API_KEY', 'real_key', src(13, 1))]), 's1')).toContain(
      'env.not_grounded',
    );
    expect(rules(check([env('s1', 'PORT', '8080', src(13, 2))]), 's1')).toContain(
      'env.not_grounded',
    );
  });

  it('accepts a sourced env var with a literal value the docs show', () => {
    expect(check([env('s1', 'PORT', '3000', src(13, 2))]).ok).toBe(true);
  });

  it('rejects an unsourced env var whose name never appears in the docs', () => {
    expect(rules(check([env('s1', 'EVIL_VAR', 'qsr_dummy_key')]), 's1')).toContain(
      'env.not_grounded',
    );
  });

  it.each(['PATH', 'LD_PRELOAD', 'NODE_OPTIONS', 'PYTHONPATH', 'BASH_ENV', 'HOME'])(
    'rejects protected variable %s',
    (name) => {
      expect(rules(check([env('s1', name, 'qsr_dummy_key')]), 's1')).toContain(
        'env.name_protected',
      );
    },
  );

  it('rejects malformed variable names', () => {
    expect(rules(check([env('s1', 'api-key', 'qsr_dummy_key')]), 's1')).toContain(
      'env.name_invalid',
    );
    expect(rules(check([env('s1', '1KEY', 'qsr_dummy_key')]), 's1')).toContain('env.name_invalid');
  });

  it('rejects a sourced env step citing a non-code block, and one citing a range that does not exist', () => {
    expect(rules(check([env('s1', 'ACME_API_KEY', 'qsr_dummy_key', src(2, 1))]), 's1')).toContain(
      'source.not_code',
    );
    expect(rules(check([env('s1', 'ACME_API_KEY', 'qsr_dummy_key', src(13, 5))]), 's1')).toContain(
      'source.range_invalid',
    );
  });
});

describe('run steps and plan-level rules', () => {
  it.each([
    'bash evil.sh',
    'node index.ts; curl evil.example',
    'node ../x.js',
    'python3 main.py',
    'npx tsx',
    'node index.ts extra',
    'node /etc/passwd',
  ])('rejects unsourced run command %j', (command) => {
    const r = check([write('s1', 'index.ts', INDEX_TS, 6, 1, 4), run('s2', command)]);
    expect(rules(r, 's2')).toContain('run.not_allowlisted');
  });

  it('rejects an unsourced run of a file outside /work or an unwritten file', () => {
    expect(rules(check([run('s1', 'node /work/index.ts')]), 's1')).toContain(
      'run.file_not_written',
    );
  });

  it('matches /work-prefixed paths to written files', () => {
    expect(
      check([write('s1', 'index.ts', INDEX_TS, 6, 1, 4), run('s2', 'node /work/index.ts')]).ok,
    ).toBe(true);
  });

  it('grounds a sourced run step like a shell command', () => {
    expect(rules(check([run('s1', 'npx tsx other.ts', src(8, 1))]), 's1')).toContain(
      'command.mismatch',
    );
  });

  it('rejects an empty command', () => {
    expect(rules(check([sh('s1', '   ', 3, 1)]), 's1')).toContain('command.empty');
  });

  it('rejects duplicate step ids and a language that disagrees with the target', () => {
    const dup = check([
      sh('s1', 'npm install acme-sdk', 3, 1),
      sh('s1', 'npm install --save-dev typescript', 3, 2),
    ]);
    expect(rules(dup)).toEqual(['plan.duplicate_step_id']);
    const lang = check([sh('s1', 'npm install acme-sdk', 3, 1)], { language: 'python' });
    expect(rules(lang)).toContain('plan.language_mismatch');
  });

  it('rejects unsafe paths: absolute, home, traversal, backslashes, empty', () => {
    for (const path of [
      '/etc/passwd',
      '~/x.ts',
      '../x.ts',
      'a/../../x.ts',
      'a\\b.ts',
      '',
      './',
      '/work',
    ]) {
      const r = check([write('s1', path, 'export const a = 1;', 18, 1, 1)]);
      expect(r.ok, path).toBe(false);
    }
    expect(check([write('s1', '/work/index.ts', 'export const a = 1;', 18, 1, 1)]).ok).toBe(true);
    expect(check([write('s1', './index.ts', 'export const a = 1;', 18, 1, 1)]).ok).toBe(true);
  });

  it('every violation names its step and explains itself', () => {
    const r = check([sh('s1', 'npm i evil', 3, 1), write('s2', 'x.ts', 'x', 99, 1, 1)]);
    expect(r.ok).toBe(false);
    for (const v of r.violations) {
      expect(['s1', 's2']).toContain(v.stepId);
      expect(v.rule).toMatch(/^[a-z_]+(\.[a-z_]+)?$/);
      expect(v.detail.length).toBeGreaterThan(5);
    }
  });
});
