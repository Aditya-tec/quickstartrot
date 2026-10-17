import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

// Nothing in the app may turn data into markup. Logs, diffs, summaries and names are all rendered as React text
// (which escapes), so a hostile string from a docs page or a log can never become HTML. Two guards: a lint rule
// (so the editor and CI complain) and this test, which reads the source.

const ROOT = path.resolve(import.meta.dirname, '..');
const FORBIDDEN = [
  'dangerouslySetInnerHTML',
  'innerHTML',
  'outerHTML',
  'insertAdjacentHTML',
  'document.write',
  'createContextualFragment',
  'srcdoc',
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}

describe('no raw HTML anywhere in the app', () => {
  it('finds source files to check', () => {
    expect(sourceFiles(ROOT).length).toBeGreaterThan(30);
  });

  it.each(FORBIDDEN)('no source file uses %s', (word) => {
    const offenders = sourceFiles(ROOT).filter((file) => readFileSync(file, 'utf8').includes(word));
    expect(offenders.map((f) => path.relative(ROOT, f))).toEqual([]);
  });

  it('the lint rule rejects dangerouslySetInnerHTML in a component', async () => {
    const eslint = new ESLint({ cwd: path.resolve(ROOT, '..', '..', '..') });
    const [result] = await eslint.lintText(
      'export function X({ html }: { html: string }) { return <div dangerouslySetInnerHTML={{ __html: html }} />; }\n',
      { filePath: path.join(ROOT, 'components', 'zz-probe.tsx') },
    );
    expect(result?.messages.map((m) => m.message).join('\n')).toMatch(/dangerouslySetInnerHTML/);
  });

  it('the lint rule rejects assigning innerHTML', async () => {
    const eslint = new ESLint({ cwd: path.resolve(ROOT, '..', '..', '..') });
    const [result] = await eslint.lintText(
      'export function x(el: HTMLElement, s: string) { el.innerHTML = s; }\n',
      { filePath: path.join(ROOT, 'lib', 'zz-probe.ts') },
    );
    expect(result?.messages.map((m) => m.message).join('\n')).toMatch(/innerHTML/);
  });
});
