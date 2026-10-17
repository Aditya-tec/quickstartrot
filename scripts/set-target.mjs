// Records a decision about a target in its YAML file and in docs/target-candidates.json (the public record).
//   node scripts/set-target.mjs <slug> --level 2 --enabled true|false --notes "what I saw" [--placeholder KEY=VALUE]...
//        [--reason "one line for the candidates table"] [--status enabled|disabled|excluded] [--owners-x @x --owners-github org/repo]
// `--status excluded` removes the target file (it stays in the candidates table with its reason).
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { parseArgs } from 'node:util';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.join(root, 'packages/cli/package.json'));
const { parseDocument } = require('yaml');

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    level: { type: 'string' },
    enabled: { type: 'string' },
    notes: { type: 'string' },
    reason: { type: 'string' },
    status: { type: 'string' },
    placeholder: { type: 'string', multiple: true },
    'owners-x': { type: 'string' },
    'owners-github': { type: 'string' },
    'auth-error-is-pass': { type: 'string' },
    'code-blocks': { type: 'string' },
    root: { type: 'string' },
    tab: { type: 'string' },
    'docs-url': { type: 'string' },
  },
});
const slug = positionals[0];
if (!slug) throw new Error('usage: node scripts/set-target.mjs <slug> [options]');

const candidatesFile = path.join(root, 'docs/target-candidates.json');
const candidates = JSON.parse(readFileSync(candidatesFile, 'utf8'));
const candidate = candidates.find((c) => c.slug === slug);
if (!candidate) throw new Error(`${slug} is not in docs/target-candidates.json: add it first`);

const file = path.join(root, 'targets', `${slug}.yaml`);
if (values.status === 'excluded') {
  if (existsSync(file)) unlinkSync(file);
  candidate.status = 'excluded';
  candidate.reason = values.reason ?? candidate.reason ?? '';
  delete candidate.level;
} else {
  if (!existsSync(file))
    throw new Error(`${file} does not exist: run scripts/draft-target.mjs first`);
  const doc = parseDocument(readFileSync(file, 'utf8'));
  if (values.level) doc.set('level', Number(values.level));
  if (values.enabled === 'true') doc.delete('enabled');
  if (values.enabled === 'false') doc.set('enabled', false);
  if (values.notes !== undefined) doc.set('notes', values.notes);
  if (values['docs-url']) doc.set('docsUrl', values['docs-url']);
  if (values.root) doc.setIn(['extract', 'root'], values.root);
  if (values['code-blocks']) doc.setIn(['extract', 'codeBlocks'], values['code-blocks']);
  if (values.tab === '') doc.deleteIn(['extract', 'tab']);
  else if (values.tab) doc.setIn(['extract', 'tab'], values.tab);
  if (values.placeholder?.length) {
    const map = {};
    for (const p of values.placeholder) {
      const i = p.indexOf('=');
      map[p.slice(0, i)] = p.slice(i + 1);
    }
    doc.set('placeholders', map);
  }
  if (values['auth-error-is-pass'] === 'true')
    doc.set('expect', { authErrorIsPass: true, timeoutSec: 300 });
  if (values['owners-x'] || values['owners-github']) {
    doc.set('owners', {
      ...(values['owners-x'] ? { x: values['owners-x'] } : {}),
      ...(values['owners-github'] ? { github: values['owners-github'] } : {}),
    });
  }
  // keep a stable key order: enabled and notes last
  const out = doc.toJS();
  const { enabled, notes, ...rest } = out;
  const ordered = {
    ...rest,
    ...(enabled === false ? { enabled: false } : {}),
    ...(notes === undefined ? {} : { notes }),
  };
  const { stringify } = require('yaml');
  writeFileSync(file, stringify(ordered, { lineWidth: 0, singleQuote: true }));
  const final = ordered;
  candidate.status = values.status ?? (final.enabled === false ? 'disabled' : 'enabled');
  candidate.level = final.level;
  if (values.reason !== undefined) candidate.reason = values.reason;
}
writeFileSync(candidatesFile, `${JSON.stringify(candidates, null, 2)}\n`);
console.log(
  `${slug}: ${candidate.status}${candidate.level ? ` L${candidate.level}` : ''} ${candidate.reason ?? ''}`,
);
