import { describe, expect, it } from 'vitest';
import { splitRunnerEnv } from './run-env';

// The run page shows the environment of a run: resolved packages (a JSON string inside runner_env) and the
// remaining keys. Malformed data must never break the page.

describe('splitRunnerEnv', () => {
  it('reads resolved packages, sorted by name', () => {
    const r = splitRunnerEnv({
      resolved: JSON.stringify({ zod: '4.0.0', 'acme-sdk': '3.4.1' }),
      hostPlatform: 'linux',
    });
    expect(r.packages).toEqual([
      ['acme-sdk', '3.4.1'],
      ['zod', '4.0.0'],
    ]);
    expect(r.other).toEqual([['hostPlatform', 'linux']]);
  });

  it('does not list resolved or plan_stale among the other keys', () => {
    const r = splitRunnerEnv({ resolved: '{}', plan_stale: 'true', shard: '1' });
    expect(r.other).toEqual([['shard', '1']]);
  });

  it('treats malformed resolved JSON as no packages', () => {
    expect(splitRunnerEnv({ resolved: '{not json' }).packages).toEqual([]);
    expect(splitRunnerEnv({ resolved: '[1,2]' }).packages).toEqual([]);
    expect(splitRunnerEnv({ resolved: '{"a":1}' }).packages).toEqual([]);
  });

  it('handles an empty environment', () => {
    expect(splitRunnerEnv({})).toEqual({ packages: [], other: [] });
  });
});
