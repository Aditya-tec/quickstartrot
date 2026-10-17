import { describe, expect, it } from 'vitest';
import { cjsInput, esmInput, installOnlyInput, pythonInput } from './fixtures.test-utils.js';
import { groundingReport, type MutationInput } from './inputs.js';
import {
  applyOperator,
  firstInstall,
  OPERATOR_IDS,
  previousMajorPlan,
  resolvedMajor,
  type Mutant,
  type OperatorId,
} from './operators.js';
import { createRng } from './rng.js';

// Every operator must hand back a pair the REAL grounding validator accepts: the mutant is a plausible broken quickstart, never
// an obviously forged plan. The fixtures are small but cover the shapes the operators look for.

const MUTATING = OPERATOR_IDS.filter(
  (id): id is Exclude<OperatorId, 'previous_major'> => id !== 'previous_major',
);
const mutate = (
  input: MutationInput,
  op: Exclude<OperatorId, 'previous_major'>,
  seed = 's',
): Mutant | null =>
  applyOperator(
    op,
    { extraction: input.extraction, ir: input.ir },
    createRng(seed, `${input.target.slug}:${op}`),
    input.target.placeholders,
  );

const fixtures: [string, () => MutationInput][] = [
  ['node ES module', esmInput],
  ['node CommonJS with a run step', cjsInput],
  ['python', pythonInput],
];

describe('the starting pairs are valid', () => {
  it.each([...fixtures, ['install only', installOnlyInput] as [string, () => MutationInput]])(
    '%s: the real validator accepts the unmutated pair',
    (_n, make) => {
      const i = make();
      expect(groundingReport({ extraction: i.extraction, ir: i.ir }, i.target)).toEqual({
        ok: true,
        violations: [],
      });
    },
  );
});

describe('every operator yields a pair the real validator accepts', () => {
  for (const op of MUTATING) {
    it.each(fixtures)(`${op} on %s`, (_n, make) => {
      const input = make();
      const m = mutate(input, op);
      if (m === null) return; // not applicable to this shape; covered below
      expect(m.operator).toBe(op);
      expect(groundingReport(m.pair, input.target), JSON.stringify(m.change)).toEqual({
        ok: true,
        violations: [],
      });
      // the change really happened, on both sides
      expect(JSON.stringify(m.pair.extraction.blocks)).not.toBe(
        JSON.stringify(input.extraction.blocks),
      );
      expect(JSON.stringify(m.pair.ir.steps)).not.toBe(JSON.stringify(input.ir.steps));
      // and nothing else moved: same blocks, same step ids and kinds
      expect(m.pair.extraction.blocks.map((b) => [b.index, b.kind])).toEqual(
        input.extraction.blocks.map((b) => [b.index, b.kind]),
      );
      expect(m.pair.ir.steps.map((s) => [s.id, s.kind])).toEqual(
        input.ir.steps.map((s) => [s.id, s.kind]),
      );
    });
  }

  it('each operator finds a site somewhere in the fixtures', () => {
    for (const op of MUTATING) {
      const hits = fixtures.filter(([, make]) => mutate(make(), op) !== null);
      expect(hits.length, op).toBeGreaterThan(0);
    }
  });
});

describe('what each operator does', () => {
  it('pkg_typo changes the package name in the install command only', () => {
    const m = mutate(esmInput(), 'pkg_typo') as Mutant;
    const s1 = m.pair.ir.steps[0];
    expect(s1?.kind === 'shell' && s1.command).toBe('npm install acmeqq-sdk');
    expect(m.pair.extraction.blocks[1]?.text).toBe('npm install acmeqq-sdk');
    expect(m.pair.extraction.blocks[3]?.text).toContain("from 'acme-sdk'"); // the import still names the real package
  });

  it('pkg_typo keeps a scope and pip syntax intact', () => {
    const scoped = mutate(installOnlyInput(), 'pkg_typo') as Mutant;
    expect(scoped.pair.extraction.blocks[1]?.text).toBe('npm install @scope/acmeqq-sdk');
    const py = mutate(pythonInput(), 'pkg_typo') as Mutant;
    expect(py.pair.extraction.blocks[1]?.text).toBe('pip install acmeqq-sdk');
  });

  it('version_pin pins 999.999.999 in the manager syntax', () => {
    expect((mutate(esmInput(), 'version_pin') as Mutant).pair.extraction.blocks[1]?.text).toBe(
      'npm install acme-sdk@999.999.999',
    );
    expect((mutate(pythonInput(), 'version_pin') as Mutant).pair.extraction.blocks[1]?.text).toBe(
      'pip install acme-sdk==999.999.999',
    );
  });

  it('renamed_symbol renames the binding everywhere in the snippet, or only the imported side of an alias', () => {
    const outcomes = new Set<string>();
    for (const seed of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) {
      const m = mutate(esmInput(), 'renamed_symbol', seed) as Mutant;
      const code = m.pair.extraction.blocks[3]?.text ?? '';
      outcomes.add(m.change);
      if (m.change.startsWith('Acme ->')) {
        expect(code).toContain('AcmeQsr');
        expect(code).not.toMatch(/\bAcme\b/);
      }
      if (m.change.startsWith('Mailer ->')) {
        expect(code).toContain('MailerQsr as Sender');
      }
    }
    expect(outcomes.size).toBeGreaterThan(0);
  });

  it('renamed_symbol handles a destructured require and a python from-import', () => {
    expect(
      (mutate(cjsInput(), 'renamed_symbol') as Mutant).pair.extraction.blocks[3]?.text,
    ).toContain('const { AcmeQsr } = require');
    expect(
      (mutate(pythonInput(), 'renamed_symbol') as Mutant).pair.extraction.blocks[3]?.text,
    ).toContain('from acme import Client_qsr');
  });

  it('renamed_method renames a call on an object the snippet created', () => {
    const m = mutate(cjsInput(), 'renamed_method') as Mutant;
    expect(m.pair.extraction.blocks[3]?.text).toContain('acme.sendQsr(');
    expect(m.change).toContain('acme.send(');
    const py = mutate(pythonInput(), 'renamed_method') as Mutant;
    expect(py.pair.extraction.blocks[3]?.text).toContain('client.send_qsr(');
  });

  it('deep_import adds a sub-path that does not exist', () => {
    expect((mutate(esmInput(), 'deep_import') as Mutant).pair.extraction.blocks[3]?.text).toContain(
      "'acme-sdk/dist/qsr-missing'",
    );
    expect(
      (mutate(pythonInput(), 'deep_import') as Mutant).pair.extraction.blocks[3]?.text,
    ).toContain('from acme.qsr_missing import Client');
  });

  it('deep_import leaves node: builtins and relative imports alone', () => {
    const m = mutate(esmInput(), 'deep_import') as Mutant;
    expect(m.pair.extraction.blocks[3]?.text).toContain("from 'node:fs/promises'");
  });

  it('syntax_error removes one closing bracket (or quote) from one line', () => {
    const m = mutate(esmInput(), 'syntax_error') as Mutant;
    const before = (esmInput().extraction.blocks[3]?.text ?? '').split('\n');
    const after = (m.pair.extraction.blocks[3]?.text ?? '').split('\n');
    const changed = after.map((l, i) => [l, before[i]]).filter(([a, b]) => a !== b);
    expect(changed).toHaveLength(1);
    expect((changed[0]?.[1] ?? '').length - (changed[0]?.[0] ?? '').length).toBe(1);
  });

  it('option_misnamed renames an option key inside a call', () => {
    const m = mutate(cjsInput(), 'option_misnamed') as Mutant;
    expect(m.change).toMatch(/option (apiKey|region) ->/);
    const py = mutate(pythonInput(), 'option_misnamed') as Mutant;
    expect(py.pair.extraction.blocks[3]?.text).toMatch(/(api_key|to|subject)_qsr=/);
  });
});

describe('operators that have no site say so', () => {
  it('an install-only plan has only the install operators', () => {
    const i = installOnlyInput();
    expect(mutate(i, 'pkg_typo')).not.toBeNull();
    expect(mutate(i, 'version_pin')).not.toBeNull();
    for (const op of [
      'renamed_symbol',
      'renamed_method',
      'deep_import',
      'syntax_error',
      'option_misnamed',
    ] as const)
      expect(mutate(i, op), op).toBeNull();
  });
});

describe('determinism', () => {
  it('the same seed and inputs give the same mutants, in every operator', () => {
    for (const [, make] of fixtures)
      for (const op of MUTATING) {
        const a = mutate(make(), op, 'seed-1');
        const b = mutate(make(), op, 'seed-1');
        expect(JSON.stringify(a)).toBe(JSON.stringify(b));
      }
  });

  it('a different seed can choose a different site', () => {
    const changes = new Set<string>();
    for (const seed of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'])
      changes.add((mutate(esmInput(), 'syntax_error', seed) as Mutant).change);
    expect(changes.size).toBeGreaterThan(1);
  });
});

describe('operator 8: the previous major version (an executor override)', () => {
  it('pins the install to the major before the one the control resolved', () => {
    const out = previousMajorPlan(esmInput().ir, 6);
    const s = out?.ir.steps[0];
    expect(s?.kind === 'shell' && s.command).toBe('npm install acme-sdk@5');
    const py = previousMajorPlan(pythonInput().ir, 3);
    const p = py?.ir.steps[0];
    expect(p?.kind === 'shell' && p.command).toBe("pip install 'acme-sdk<3'");
  });

  it('does not touch the docs lines, and there is nothing to step back from at major 0', () => {
    expect(previousMajorPlan(esmInput().ir, 0)).toBeNull();
    expect(JSON.stringify(esmInput().extraction)).toBe(JSON.stringify(esmInput().extraction));
  });

  it('reads the major from the resolved map, whatever the spelling of the name', () => {
    expect(resolvedMajor({ 'acme-sdk': '6.3.0', other: '1.0.0' }, 'acme-sdk')).toBe(6);
    expect(resolvedMajor({ Acme_SDK: 'v2.1.0' }, 'acme-sdk')).toBe(2);
    expect(resolvedMajor({}, 'acme-sdk')).toBeNull();
  });

  it('finds the first install of a plan', () => {
    expect(firstInstall(installOnlyInput().ir)?.name).toBe('@scope/acme-sdk');
    expect(firstInstall(pythonInput().ir)?.manager).toBe('pip');
  });
});

describe('renamed_method follows a chain of calls (client.messages.create)', () => {
  it('renames the last name before the bracket, on both sides', () => {
    const input = cjsInput();
    const chained = {
      ...input,
      extraction: {
        ...input.extraction,
        blocks: input.extraction.blocks.map((b) =>
          b.index === 3 ? { ...b, text: b.text.replace('acme.send(', 'acme.messages.create(') } : b,
        ),
      },
      ir: {
        ...input.ir,
        steps: input.ir.steps.map((s) =>
          s.kind === 'write_file'
            ? { ...s, content: s.content.replace('acme.send(', 'acme.messages.create(') }
            : s,
        ),
      },
    };
    expect(
      groundingReport({ extraction: chained.extraction, ir: chained.ir }, chained.target).ok,
    ).toBe(true);
    const m = mutate(chained, 'renamed_method') as Mutant;
    expect(m.pair.extraction.blocks[3]?.text).toContain('acme.messages.createQsr(');
    expect(groundingReport(m.pair, chained.target).ok).toBe(true);
  });
});
