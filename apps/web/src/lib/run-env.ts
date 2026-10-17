import { z } from 'zod';

// Splits a run's runner_env for display: the resolved packages (the executor stores them as a JSON string under
// "resolved") and every other key. "plan_stale" is shown as a marker on its own, so it is left out here.

const Resolved = z.record(z.string(), z.string());
const HIDDEN = new Set(['resolved', 'plan_stale']);

export interface SplitEnv {
  packages: [string, string][];
  other: [string, string][];
}

export function splitRunnerEnv(env: Readonly<Record<string, string>>): SplitEnv {
  let packages: [string, string][] = [];
  const raw = env['resolved'];
  if (raw !== undefined) {
    try {
      const parsed = Resolved.safeParse(JSON.parse(raw));
      if (parsed.success)
        packages = Object.entries(parsed.data).sort(([a], [b]) => a.localeCompare(b));
    } catch {
      packages = [];
    }
  }
  const other = Object.entries(env)
    .filter(([key]) => !HIDDEN.has(key))
    .sort(([a], [b]) => a.localeCompare(b));
  return { packages, other };
}
