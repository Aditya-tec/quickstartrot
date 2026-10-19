import { describe, expect, it } from 'vitest';
import type { ExtractionBlock, Step } from '@qsr/core';
import {
  commentPayload,
  markCommentInstalls,
  quarantineDestructive,
  validateGrounding,
} from './index.js';
import type { GroundingContext } from './index.js';
import { plan, run, sh, src, write } from './fixtures.test-utils.js';

// Some quickstarts show the install command only inside a code comment:
//     // npm install firecrawl          # pip install firecrawl-py
//     import { Firecrawl } from 'firecrawl';
// A target whose page does this declares `grounding.installFromComment`. For such a target, and nowhere else, an INSTALL command may be
// cited from a comment line: the command must be the whole comment with its marker removed (or a whole sub-command of it), it must be an
// install command, and the plan records `source.commentOnly`. Nothing else about the validator is relaxed.

const code = (index: number, lang: string | null, text: string): ExtractionBlock => ({
  index,
  kind: 'code',
  lang,
  text,
  filenameHint: null,
  headingPath: ['Quickstart'],
});

/** A zero-width space, built from its code point so this file never contains the character itself. */
const HIDDEN = String.fromCodePoint(0x200b);

const BLOCKS: ExtractionBlock[] = [
  code(
    0,
    'javascript',
    "// npm install acme-sdk\n\nimport { Acme } from 'acme-sdk';\nconst acme = new Acme();",
  ), // 0
  code(1, 'python', '# pip install acme-py\n\nimport acme\nprint(acme.__name__)'), // 1
  code(2, 'bash', '# Install the SDK\nnpm install acme-sdk'), // 2
  code(3, 'js', '// cd app && npm install acme-sdk'), // 3
  code(4, 'js', '// sudo npm install -g acme-sdk'), // 4
  code(5, 'js', '// node index.js'), // 5
  code(6, 'js', '//   npm install acme-sdk   \n// npm install acme-extra'), // 6
  code(7, 'bash', '#!/bin/sh\nnpm install acme-sdk'), // 7
  {
    index: 8,
    kind: 'prose',
    lang: null,
    text: '// npm install acme-sdk',
    filenameHint: null,
    headingPath: [],
  }, // 8
  code(9, 'js', `// npm install acme${HIDDEN}-sdk`), // 9 (a hidden character)
  code(10, 'bash', '# npm install acme-sdk\nnpm run dev'), // 10 (a comment, then another command)
];

const ctx = (over: Partial<GroundingContext> = {}): GroundingContext => ({
  blocks: BLOCKS,
  placeholders: {},
  language: 'node',
  installFromComment: true,
  ...over,
});
const flagged = (
  id: string,
  command: string,
  block: number,
  from: number,
  to: number = from,
): Step => ({
  kind: 'shell',
  id,
  command,
  source: { ...src(block, from, to), commentOnly: true },
  expect: { exitCode: 0, authErrorIsPass: false, stdoutIncludes: [], timeoutSec: 180 },
});
const rules = (r: ReturnType<typeof validateGrounding>): string[] =>
  r.violations.map((v) => v.rule);

describe('commentPayload: the text of a comment, or null when the lines are not all comments', () => {
  it('removes the marker and the blanks around the text', () => {
    expect(commentPayload('// npm install acme-sdk')).toBe('npm install acme-sdk');
    expect(commentPayload('#   pip install acme-py  ')).toBe('pip install acme-py');
    expect(commentPayload('  // indented')).toBe('indented');
    expect(commentPayload('//npm install x')).toBe('npm install x');
  });

  it('joins several comment lines, and drops empty ones in between', () => {
    expect(commentPayload('// npm install a\n//\n// npm install b')).toBe(
      'npm install a\nnpm install b',
    );
    expect(commentPayload('# one\r\n# two')).toBe('one\ntwo');
  });

  it('is null as soon as one line is code, a shebang, empty or a bare marker', () => {
    expect(commentPayload("import x from 'x';")).toBeNull();
    expect(commentPayload('// npm install x\nimport y;')).toBeNull();
    expect(commentPayload('#!/bin/sh')).toBeNull();
    expect(commentPayload('')).toBeNull();
    expect(commentPayload('//')).toBeNull();
    expect(commentPayload('#')).toBeNull();
    expect(commentPayload('/* npm install x */')).toBeNull();
    expect(commentPayload('npm install x // not at the start')).toBeNull();
  });
});

describe('markCommentInstalls: the plan records where a command came from', () => {
  it('flags a shell step whose cited lines are a comment, for a target that allows it', () => {
    const out = markCommentInstalls(plan([sh('s1', 'npm install acme-sdk', 0, 1)]), ctx());
    expect((out.steps[0] as { source: { commentOnly?: true } }).source.commentOnly).toBe(true);
  });

  it('flags nothing for a target that does not allow it', () => {
    const out = markCommentInstalls(
      plan([sh('s1', 'npm install acme-sdk', 0, 1)]),
      ctx({ installFromComment: false }),
    );
    expect('commentOnly' in (out.steps[0] as { source: object }).source).toBe(false);
  });

  it('leaves a command cited from real code lines alone', () => {
    const out = markCommentInstalls(plan([sh('s1', 'npm install acme-sdk', 2, 2)]), ctx());
    expect('commentOnly' in (out.steps[0] as { source: object }).source).toBe(false);
  });

  it('removes a flag the model wrote itself where the lines are not a comment (the compiler decides, not the model)', () => {
    const claimed = flagged('s1', 'npm install acme-sdk', 2, 2);
    const out = markCommentInstalls(plan([claimed]), ctx());
    expect('commentOnly' in (out.steps[0] as { source: object }).source).toBe(false);
    // and with the target not allowing it, even a true comment loses the flag
    const out2 = markCommentInstalls(
      plan([flagged('s1', 'npm install acme-sdk', 0, 1)]),
      ctx({ installFromComment: false }),
    );
    expect('commentOnly' in (out2.steps[0] as { source: object }).source).toBe(false);
  });

  it('does not touch run steps, file steps, steps without a source, or a citation that does not resolve', () => {
    const steps: Step[] = [
      run('s1', 'node index.js'),
      write('s2', 'index.js', 'x', 0, 3, 4),
      sh('s3', 'npm install acme-sdk', 99, 1),
      sh('s4', 'npm install acme-sdk', 0, 50),
      sh('s5', 'npm install acme-sdk', 8, 1), // a prose block
    ];
    const out = markCommentInstalls(plan(steps), ctx());
    expect(out.steps).toEqual(steps);
  });
});

describe('validateGrounding: an install command cited from a comment', () => {
  it('accepts it for a target that allows it, in node and in python', () => {
    expect(validateGrounding(plan([flagged('s1', 'npm install acme-sdk', 0, 1)]), ctx())).toEqual({
      ok: true,
      violations: [],
    });
    expect(
      validateGrounding(
        plan([flagged('s1', 'pip install acme-py', 1, 1)], {
          language: 'python',
          projectInit: 'python_venv',
        }),
        ctx({ language: 'python' }),
      ).ok,
    ).toBe(true);
  });

  it('accepts a whole sub-command of the comment, as for any command', () => {
    expect(validateGrounding(plan([flagged('s1', 'npm install acme-sdk', 3, 1)]), ctx()).ok).toBe(
      true,
    );
  });

  it('accepts the comment line in a block that also has real commands, when the cited line is the comment', () => {
    expect(validateGrounding(plan([flagged('s1', 'npm install acme-sdk', 6, 1)]), ctx()).ok).toBe(
      true,
    );
  });

  it('refuses it for a target that does not allow it', () => {
    const r = validateGrounding(
      plan([flagged('s1', 'npm install acme-sdk', 0, 1)]),
      ctx({ installFromComment: false }),
    );
    expect(rules(r)).toEqual(['command.comment_not_allowed']);
  });

  it('refuses a flag on lines that are not a comment', () => {
    const r = validateGrounding(plan([flagged('s1', 'npm install acme-sdk', 2, 2)]), ctx());
    expect(rules(r)).toEqual(['command.comment_flag_wrong']);
  });

  it('refuses a command that is not an install, whatever the comment says', () => {
    const r = validateGrounding(plan([flagged('s1', 'node index.js', 5, 1)]), ctx());
    expect(rules(r)).toEqual(['command.comment_not_install']);
  });

  it('refuses a command that is not what the comment says, or only part of a word of it', () => {
    expect(
      rules(validateGrounding(plan([flagged('s1', 'npm install other-sdk', 0, 1)]), ctx())),
    ).toEqual(['command.mismatch']);
    expect(
      rules(validateGrounding(plan([flagged('s1', 'npm install acme-s', 0, 1)]), ctx())),
    ).toEqual(['command.mismatch']);
    expect(rules(validateGrounding(plan([flagged('s1', '', 0, 1)]), ctx()))).toContain(
      'command.empty',
    );
  });

  it('refuses a flagged run step: only a shell step installs', () => {
    const step: Step = {
      kind: 'run',
      id: 's1',
      command: 'npm install acme-sdk',
      source: { ...src(0, 1), commentOnly: true },
      expect: { exitCode: 0, authErrorIsPass: false, stdoutIncludes: [], timeoutSec: 180 },
    };
    expect(rules(validateGrounding(plan([step]), ctx()))).toEqual(['command.comment_not_install']);
  });

  it('still applies the denylist and the hidden-character check to a command taken from a comment', () => {
    expect(
      rules(validateGrounding(plan([flagged('s1', 'sudo npm install -g acme-sdk', 4, 1)]), ctx())),
    ).toContain('denylist');
    expect(
      rules(validateGrounding(plan([flagged('s1', `npm install acme${HIDDEN}-sdk`, 9, 1)]), ctx())),
    ).toContain('text.suspicious_characters');
  });

  it('turns a destructive command from a comment into a manual step, like any other', () => {
    const { ir, quarantined } = quarantineDestructive(
      plan([flagged('s1', 'sudo npm install -g acme-sdk', 4, 1)]),
      ctx(),
    );
    expect(quarantined).toEqual(['s1']);
    expect(ir.steps[0]?.kind).toBe('manual');
  });

  it('a block that is prose is still not a source', () => {
    expect(
      rules(validateGrounding(plan([flagged('s1', 'npm install acme-sdk', 8, 1)]), ctx())),
    ).toEqual(['source.not_code']);
  });
});

describe('without the flag, nothing changes', () => {
  it('a command cited from a comment is a mismatch, as before', () => {
    const r = validateGrounding(
      plan([sh('s1', 'npm install acme-sdk', 0, 1)]),
      ctx({ installFromComment: false }),
    );
    expect(rules(r).sort()).toEqual(['command.source_not_shell']);
    const r2 = validateGrounding(
      plan([sh('s1', 'npm install acme-sdk', 2, 1)]),
      ctx({ installFromComment: false }),
    );
    expect(rules(r2)).toEqual(['command.mismatch']);
    expect(r2.violations[0]?.detail).not.toContain('comment');
  });

  it('a target that allows comments gets a hint when the model cited the comment together with the code under it', () => {
    // block 0 is a javascript block: the comment is line 1, the model cited lines 1-2
    const r = validateGrounding(plan([sh('s1', 'npm install acme-sdk', 0, 1, 2)]), ctx());
    expect(rules(r)).toEqual(['command.source_not_shell']);
    expect(r.violations[0]?.detail).toContain('is written as a comment on line 1 of block 0');
    // and in a shell block, where the line after the comment is another command
    const r2 = validateGrounding(plan([sh('s1', 'npm install acme-sdk', 10, 1, 2)]), ctx());
    expect(rules(r2)).toEqual(['command.mismatch']);
    expect(r2.violations[0]?.detail).toContain('is written as a comment on line 1 of block 10');
  });

  it('the hint is only given when the command really is a comment of the cited block, and only to a target that allows it', () => {
    const none = validateGrounding(
      plan([sh('s1', 'npm install nothing-like-it', 10, 1, 2)]),
      ctx(),
    );
    expect(none.violations[0]?.detail).not.toContain('is written as a comment');
    const off = validateGrounding(
      plan([sh('s1', 'npm install acme-sdk', 10, 1, 2)]),
      ctx({ installFromComment: false }),
    );
    expect(off.violations[0]?.detail).not.toContain('is written as a comment');
  });
});
