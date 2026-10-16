import { describe, expect, it } from 'vitest';
import { interactiveScaffolder, quarantineInteractive } from './interactive.js';
import { validateGrounding } from './index.js';
import { ctx, env, manual, plan, sh, write } from './fixtures.test-utils.js';

describe('interactiveScaffolder: commands that ask questions and so need a human', () => {
  it.each([
    'npm create hono@latest my-app',
    'npm create vite@latest',
    'npm init vite@latest my-app',
    'pnpm create next-app',
    'yarn create react-app my-app',
    'bun create elysia app',
    'npx create-react-app my-app',
    'npx create-next-app@latest',
    'npx @vue/create-vue',
    'npx @scope/create my-thing',
    'npx -y create-svelte@latest',
    'npx --yes create-t3-app',
    'pnpm dlx create-turbo',
    'yarn dlx create-foo',
    'bunx create-foo',
    'npx degit user/repo my-project',
    'cd workspace && npm create hono@latest my-app',
    'echo start; npm create vite',
  ])('flags %s', (command) => {
    expect(interactiveScaffolder(command)).toMatch(/interactive scaffolder/);
  });

  it.each([
    'npm create vite@latest my-app -- --template react',
    'npm create hono@latest my-app --template basic',
    'pnpm create next-app --yes',
    'npx create-react-app my-app -y',
    'npx create-foo --defaults',
    'npx create-foo --default',
    'npx create-foo --ci',
    'npx create-foo --no-interactive',
    'npm create vite -t vue',
  ])('accepts %s because it is told not to ask', (command) => {
    expect(interactiveScaffolder(command)).toBeNull();
  });

  it.each([
    'npm init -y',
    'npm init',
    'npm init --yes',
    'npm install create-react-app',
    'npm install hono',
    'npx tsx index.ts',
    'npx vitest run',
    'npx prisma generate',
    'pip install create-foo',
    'node create-app.js',
    'echo "npm create foo"',
    '',
  ])('does not flag %s', (command) => {
    expect(interactiveScaffolder(command)).toBeNull();
  });

  it('does not mistake npx -y (auto-install the package) for the scaffolder being told not to ask', () => {
    expect(interactiveScaffolder('npx -y create-svelte@latest')).not.toBeNull();
  });
});

describe('quarantineInteractive: the plan stops at the scaffolder with a manual step', () => {
  const docsPlan = () =>
    plan([
      sh('s1', 'npm install acme-sdk', 3, 1),
      sh('s2', 'cd my-app && npm install', 9, 1),
      write('s3', 'index.ts', 'x', 6, 1, 4),
    ]);
  const scaffold = (c = ctx()) => ({
    ...c,
    blocks: c.blocks.map((b) =>
      b.index === 9 ? { ...b, text: 'npm create hono@latest my-app' } : b,
    ),
  });

  it('replaces the first scaffolder with a manual step, drops everything after it, and says why', () => {
    const c = scaffold();
    const ir = plan(
      [
        sh('s1', 'npm install acme-sdk', 3, 1),
        sh('s2', 'npm create hono@latest my-app', 9, 1),
        sh('s3', 'cd my-app', 9, 1),
        write('s4', 'src/index.ts', 'x', 6, 1, 4),
      ],
      { maxLevelReachable: 3, notes: 'Used npm.' },
    );
    const out = quarantineInteractive(ir, c);
    expect(out.quarantined).toBe('s2');
    expect(out.ir.steps.map((s) => `${s.id}:${s.kind}`)).toEqual(['s1:shell', 's2:manual']);
    expect(out.ir.steps[1]).toMatchObject({ source: { blockIndex: 9, lineStart: 1, lineEnd: 1 } });
    expect(out.ir.maxLevelReachable).toBe(1);
    // The model's own note ("Used npm.") described steps that no longer exist, so it is replaced.
    expect(out.ir.notes).toMatch(
      /^Stopped at s2: .*interactive scaffolder.*Steps after it were dropped/,
    );
    expect(out.ir.notes).not.toContain('Used npm');
    expect(validateGrounding(out.ir, c).ok).toBe(true);
  });

  it('starts the notes when there were none, and works when the scaffolder is the first step', () => {
    const c = scaffold();
    const out = quarantineInteractive(
      plan([sh('s1', 'npm create hono@latest my-app', 9, 1)], { notes: '' }),
      c,
    );
    expect(out.ir.steps).toHaveLength(1);
    expect(out.ir.steps[0]?.kind).toBe('manual');
    expect(out.ir.notes.startsWith('Stopped at s1:')).toBe(true);
  });

  it('only looks at command steps', () => {
    const c = scaffold();
    const ir = plan([manual('s1', 'npm create hono@latest', 2, 1), env('s2', 'PORT', '3000')]);
    expect(quarantineInteractive(ir, c)).toEqual({ ir, quarantined: null });
  });

  it('leaves a plan with no scaffolder untouched (same object)', () => {
    const ir = docsPlan();
    expect(quarantineInteractive(ir, ctx())).toEqual({ ir, quarantined: null });
    expect(quarantineInteractive(ir, ctx()).ir).toBe(ir);
  });

  it('leaves the step alone when its citation does not resolve, so validation reports that instead', () => {
    const ir = plan([sh('s1', 'npm create hono@latest my-app', 99, 1)]);
    const out = quarantineInteractive(ir, scaffold());
    expect(out).toEqual({ ir, quarantined: null });
    expect(validateGrounding(out.ir, scaffold()).ok).toBe(false);
  });

  it('does not mutate its input', () => {
    const c = scaffold();
    const ir = plan([sh('s1', 'npm create hono@latest my-app', 9, 1), sh('s2', 'cd my-app', 9, 1)]);
    quarantineInteractive(ir, c);
    expect(ir.steps).toHaveLength(2);
    expect(ir.steps[0]?.kind).toBe('shell');
  });
});
