// Runs `qsr run <slug>` for several targets one after another (real Docker, real Groq, no database), keeps each full
// output in .qsr-runs/<slug>.out.txt, and prints a one-line summary per target with the model tokens it used.
// Used to verify targets before they are enabled (docs/TARGET-SELECTION.md, "Process"). Sequential on purpose:
// the model quota is small and the runner is one machine.
//
//   node scripts/batch-run.mjs <slug> [slug ...]       (needs a built CLI: pnpm qsr --help builds it)
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, '.qsr-runs');
mkdirSync(out, { recursive: true });
const slugs = process.argv.slice(2);
if (slugs.length === 0) throw new Error('usage: node scripts/batch-run.mjs <slug> ...');

for (const slug of slugs) {
  const started = Date.now();
  const r = spawnSync(
    process.execPath,
    ['--env-file=.env', 'packages/cli/dist/main.js', 'run', slug],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 12 * 60_000 },
  );
  const text = `${r.stdout ?? ''}\n--- stderr ---\n${r.stderr ?? ''}`;
  writeFileSync(path.join(out, `${slug}.out.txt`), text);
  let tokens = 0;
  let calls = 0;
  for (const line of text.split('\n')) {
    if (!line.startsWith('{"level"')) continue;
    try {
      const j = JSON.parse(line);
      if (j.msg === 'llm call' && j.ok) {
        calls += 1;
        tokens += (j.tokensIn ?? 0) + (j.tokensOut ?? 0);
      }
    } catch {
      /* not a log line */
    }
  }
  const outcome = /outcome:\s+(\S+)\s+reached level (\S+) of the target's (\S+)/.exec(text);
  const err = /(COMPILER_ERROR[^\n]*|MODEL ERROR[^\n]*|CRAWL_ERROR[^\n]*)/.exec(text);
  const secs = Math.round((Date.now() - started) / 1000);
  console.log(
    `${slug.padEnd(24)} exit ${String(r.status).padEnd(4)} ${outcome ? `${outcome[1]} ${outcome[2]}/${outcome[3]}` : (err?.[1] ?? 'no result line').slice(0, 110)}  ${secs}s  model calls ${calls} tokens ${tokens}`,
  );
}
