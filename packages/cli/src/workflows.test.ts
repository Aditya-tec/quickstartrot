import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// The trust split of the probe pipeline (spec sections 12 and 14), pinned by parsing the workflow files:
// the job that runs docs code has no secrets and no permissions, only the report job may write issues, only
// the snapshot job may push, and nothing runs untrusted pull-request code with privileges.

const DIR = fileURLToPath(new URL('../../../.github/workflows', import.meta.url));

interface Step {
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
  if?: string;
  name?: string;
  id?: string;
  'continue-on-error'?: boolean;
}
type Permissions = Record<string, string> | string | undefined;
interface Job {
  name?: string;
  needs?: string | string[];
  if?: string;
  'runs-on'?: string;
  'timeout-minutes'?: number;
  permissions?: Permissions;
  strategy?: { 'fail-fast'?: boolean; 'max-parallel'?: number; matrix?: Record<string, unknown> };
  outputs?: Record<string, string>;
  steps?: Step[];
  env?: Record<string, unknown>;
  uses?: string;
  secrets?: unknown;
  environment?: unknown;
}
interface Workflow {
  name?: string;
  on?: unknown;
  concurrency?: { group?: string; 'cancel-in-progress'?: boolean };
  permissions?: Permissions;
  jobs: Record<string, Job>;
}

const files = readdirSync(DIR).filter((f) => f.endsWith('.yml'));
const text = (f: string): string => readFileSync(path.join(DIR, f), 'utf8');
/** The file without its comments: a comment may mention the very things the rules forbid. */
const code = (raw: string): string =>
  raw
    .split('\n')
    .map((l) => l.replace(/(^|\s)#.*$/, ''))
    .join('\n');
const workflow = (f: string): Workflow => parse(text(f)) as Workflow;
const all = files.map((f) => ({ file: f, wf: workflow(f), raw: text(f) }));
const job = (f: string, name: string): Job => {
  const j = workflow(f).jobs[name];
  if (!j) throw new Error(`${f} has no job ${name}`);
  return j;
};
const json = (x: unknown): string => JSON.stringify(x);

const triggers = (wf: Workflow): string[] => {
  const on = wf.on;
  if (typeof on === 'string') return [on];
  if (Array.isArray(on)) return on.map(String);
  return on && typeof on === 'object' ? Object.keys(on) : [];
};

describe('the workflow files', () => {
  it('include the ones the spec names', () => {
    expect(files).toEqual(
      expect.arrayContaining([
        'ci.yml',
        'images.yml',
        'probe.yml',
        'validate-targets.yml',
        'gc.yml',
        'snapshot.yml',
      ]),
    );
  });
});

describe('probe.yml has the shape of spec section 12', () => {
  const wf = workflow('probe.yml');

  it('runs at 17 minutes past every sixth hour, or by hand with an `only` input', () => {
    const on = wf.on as {
      schedule: { cron: string }[];
      workflow_dispatch: { inputs: Record<string, { required?: boolean }> };
    };
    expect(on.schedule).toEqual([{ cron: '17 */6 * * *' }]);
    expect(on.workflow_dispatch.inputs['only']?.required).toBe(false);
  });

  it('serialises runs without cancelling a running one, and reads contents only by default', () => {
    expect(wf.concurrency).toEqual({ group: 'probe', 'cancel-in-progress': false });
    expect(wf.permissions).toEqual({ contents: 'read' });
  });

  it('has exactly the three jobs: plan, execute, report', () => {
    expect(Object.keys(wf.jobs)).toEqual(['plan', 'execute', 'report']);
  });

  it('plan: 20 minutes, hands shards and cycle to the others, uploads the plans for 3 days', () => {
    const plan = job('probe.yml', 'plan');
    expect(plan['timeout-minutes']).toBe(20);
    expect(Object.keys(plan.outputs ?? {}).sort()).toEqual(['cycle', 'shards']);
    const upload = plan.steps?.find((s) => s.uses?.startsWith('actions/upload-artifact@'));
    expect(upload?.with).toMatchObject({ name: 'plans', 'retention-days': 3 });
    expect(plan.steps?.some((s) => s.run?.includes('playwright install'))).toBe(true);
  });

  it('execute: after plan, a matrix over the shards, no fail-fast, 10 at a time, 45 minutes', () => {
    const execute = job('probe.yml', 'execute');
    expect(execute.needs).toBe('plan');
    expect(execute.strategy?.['fail-fast']).toBe(false);
    expect(execute.strategy?.['max-parallel']).toBe(10);
    expect(String(execute.strategy?.matrix?.['shard'])).toContain(
      'fromJson(needs.plan.outputs.shards)',
    );
    expect(execute['timeout-minutes']).toBe(45);
  });

  it('execute: uploads its results even when the run failed', () => {
    const upload = job('probe.yml', 'execute').steps?.find((s) =>
      s.uses?.startsWith('actions/upload-artifact@'),
    );
    expect(upload?.if).toBe('always()');
    expect(upload?.with).toMatchObject({ 'retention-days': 3 });
  });

  it('report: runs even if execute failed, but only when the plan succeeded', () => {
    const report = job('probe.yml', 'report');
    expect(report.needs).toEqual(['plan', 'execute']);
    expect(report.if).toBe("always() && needs.plan.result == 'success'");
    expect(report['timeout-minutes']).toBe(15);
  });

  it('plan and report get the API settings; they are the only jobs that do', () => {
    for (const name of ['plan', 'report']) {
      const raw = json(job('probe.yml', name));
      expect(raw, name).toContain('secrets.INGEST_HMAC_SECRET');
      expect(raw, name).toContain('vars.API_BASE_URL');
    }
  });
});

describe('the execute job runs docs code, so it holds nothing', () => {
  const execute = job('probe.yml', 'execute');
  const raw = json(execute);

  it('references no secret, no repository variable, no API setting and no token', () => {
    expect(raw).not.toMatch(/secrets\./);
    expect(raw).not.toMatch(/vars\./);
    expect(raw).not.toMatch(/API_BASE_URL/);
    expect(raw).not.toMatch(/INGEST_HMAC_SECRET/);
    expect(raw).not.toMatch(/GITHUB_TOKEN|github\.token/);
    expect(raw).not.toMatch(/SUPABASE|GROQ|ADMIN_TOKEN/);
  });

  it('is not given secrets by inheritance, an environment or a reusable workflow', () => {
    expect(execute.secrets).toBeUndefined();
    expect(execute.environment).toBeUndefined();
    expect(execute.uses).toBeUndefined();
    expect(execute.env).toBeUndefined();
    for (const s of execute.steps ?? []) expect(s.env, s.name ?? s.run).toBeUndefined();
  });

  it('has an empty permissions block: the GITHUB_TOKEN has no scopes', () => {
    expect(execute.permissions).toEqual({});
  });

  it('checks out without keeping credentials, every time', () => {
    const checkouts = (execute.steps ?? []).filter((s) => s.uses?.startsWith('actions/checkout@'));
    expect(checkouts.length).toBeGreaterThan(0);
    for (const c of checkouts) expect(c.with?.['persist-credentials']).toBe(false);
  });

  it('the raw file text of the execute job contains none of the secret names either', () => {
    const rawText = code(text('probe.yml'));
    const start = rawText.indexOf('\n  execute:');
    const end = rawText.indexOf('\n  report:');
    const section = rawText.slice(start, end);
    expect(section.length).toBeGreaterThan(100);
    expect(section).not.toMatch(/secrets\.|vars\.|API_BASE_URL|INGEST_HMAC_SECRET|github\.token/);
  });
});

describe('every checkout, everywhere, keeps no credentials unless it is the one job that pushes', () => {
  it.each(all.map((a) => [a.file, a.wf] as const))('%s', (_file, wf) => {
    for (const [name, j] of Object.entries(wf.jobs)) {
      for (const s of j.steps ?? []) {
        if (!s.uses?.startsWith('actions/checkout@')) continue;
        expect(s.with?.['persist-credentials'], name).toBe(false);
      }
    }
  });
});

describe('pull requests never run with privileges', () => {
  it('no workflow uses pull_request_target', () => {
    for (const { file, wf, raw } of all) {
      expect(triggers(wf), file).not.toContain('pull_request_target');
      expect(code(raw), file).not.toMatch(/pull_request_target/);
    }
  });

  it('validate-targets runs on pull_request and references no secret, variable or token', () => {
    const v = workflow('validate-targets.yml');
    expect(triggers(v)).toEqual(['pull_request']);
    const raw = code(text('validate-targets.yml'));
    expect(raw).not.toMatch(/secrets\.|vars\.|github\.token|GITHUB_TOKEN/);
    expect(v.permissions).toEqual({ contents: 'read' });
  });
});

describe('write permissions are granted to exactly the jobs that need them', () => {
  const ALLOWED: Record<string, Record<string, string[]>> = {
    'probe.yml': { report: ['issues'] },
    'snapshot.yml': { snapshot: ['contents'] },
    'images.yml': { build: ['packages'] },
    'ci.yml': { codeql: ['security-events'] },
  };

  /** Every write scope a workflow grants, by job ('<top>' for the workflow level). */
  function writes(wf: Workflow): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    const scan = (where: string, p: Permissions): void => {
      if (p === 'write-all') out[where] = ['*'];
      if (p && typeof p === 'object') {
        const w = Object.entries(p)
          .filter(([, v]) => v === 'write')
          .map(([k]) => k);
        if (w.length > 0) out[where] = w;
      }
    };
    scan('<top>', wf.permissions);
    for (const [name, j] of Object.entries(wf.jobs)) scan(name, j.permissions);
    return out;
  }

  it('only the report job has issues: write, only snapshot has contents: write', () => {
    for (const { file, wf } of all) {
      for (const [where, scopes] of Object.entries(writes(wf))) {
        if (scopes.includes('issues')) expect([file, where]).toEqual(['probe.yml', 'report']);
        if (scopes.includes('contents'))
          expect([file, where]).toEqual(['snapshot.yml', 'snapshot']);
      }
    }
    expect(writes(workflow('probe.yml'))).toEqual({ report: ['issues'] });
    expect(writes(workflow('snapshot.yml'))).toEqual({ snapshot: ['contents'] });
  });

  it('no workflow has a write scope that is not on the list, and none grants write at the top level', () => {
    for (const { file, wf } of all) {
      const granted = writes(wf);
      expect(Object.keys(granted).includes('<top>'), `${file} top level`).toBe(false);
      expect(granted, file).toEqual(ALLOWED[file] ?? {});
    }
  });

  it('no job anywhere uses write-all', () => {
    for (const { raw } of all) expect(code(raw)).not.toMatch(/write-all/);
  });
});

describe('supply chain: every action is pinned to a full commit SHA', () => {
  const uses = all.flatMap(({ file, wf, raw }) =>
    Object.values(wf.jobs).flatMap((j) =>
      [...(j.steps ?? []), ...(j.uses ? [{ uses: j.uses }] : [])]
        .map((s) => s.uses)
        .filter((u): u is string => typeof u === 'string')
        .map((u) => ({ file, u, raw })),
    ),
  );

  it('there are actions to check', () => {
    expect(uses.length).toBeGreaterThan(20);
  });

  it.each(uses.map(({ file, u }) => [file, u] as const))('%s: %s', (_file, u) => {
    if (u.startsWith('./')) return;
    expect(u).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
  });

  it('each pin carries its version in a comment, so a reviewer can tell what it is', () => {
    for (const { file, raw } of all) {
      for (const line of raw.split('\n')) {
        if (!/^\s*-?\s*uses:\s*\S+@[0-9a-f]{40}/.test(line)) continue;
        expect(line, `${file}: ${line.trim()}`).toMatch(/#\s*v\d+\.\d+\.\d+/);
      }
    }
  });
});

describe('script injection: untrusted context never reaches a shell script', () => {
  it('no run: block interpolates event data, branch names or workflow inputs', () => {
    for (const { file, wf } of all) {
      for (const [name, j] of Object.entries(wf.jobs)) {
        for (const s of j.steps ?? []) {
          if (!s.run) continue;
          expect(s.run, `${file}/${name}`).not.toMatch(
            /\$\{\{\s*(github\.event|github\.head_ref|github\.base_ref|github\.ref_name|inputs\.)/,
          );
        }
      }
    }
  });
});

describe('the other workflows', () => {
  it('gc runs nightly and by hand, with the API settings only in its one job', () => {
    const wf = workflow('gc.yml');
    expect(triggers(wf).sort()).toEqual(['schedule', 'workflow_dispatch']);
    expect(wf.permissions).toEqual({ contents: 'read' });
  });

  it('snapshot runs weekly and reads with the public anon key as a repository variable', () => {
    const wf = workflow('snapshot.yml');
    const on = wf.on as { schedule: { cron: string }[] };
    expect(on.schedule).toHaveLength(1);
    expect(on.schedule[0]?.cron.split(' ')[4]).toBe('1'); // Mondays
    const raw = code(text('snapshot.yml'));
    expect(raw).toContain('vars.SUPABASE_URL');
    expect(raw).toContain('vars.SUPABASE_ANON_KEY');
    expect(raw).not.toMatch(/secrets\.(?!GITHUB_TOKEN)/);
    expect(raw).not.toMatch(/SERVICE_ROLE/);
  });

  it('ci runs actionlint and a failing lint fails the build', () => {
    const ci = workflow('ci.yml');
    const steps = Object.values(ci.jobs).flatMap((j) => j.steps ?? []);
    const lint = steps.find((s) => /actionlint/.test(`${s.run ?? ''} ${s.uses ?? ''}`));
    expect(lint, 'actionlint step').toBeDefined();
    expect(lint?.['continue-on-error']).not.toBe(true);
  });
});
