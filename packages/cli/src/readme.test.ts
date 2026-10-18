import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { Target } from '@qsr/core';
import { extractBlock } from './readme-command.js';

// The README is the first thing a founder reads. Two blocks of it are generated from data (`qsr readme`); everything else is prose, and
// the prose must not carry a figure of its own: "no claim that is not backed by a number in docs" means a number is either generated
// or it is not there.

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const readme = readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const exists = (rel: string): boolean => existsSync(path.join(ROOT, rel));

/** The README without its generated blocks, its code and its link targets: what a person wrote. */
function prose(md: string): string {
  return md
    .replaceAll(/<!-- qsr:(\w+):start -->[\s\S]*?<!-- qsr:\1:end -->/g, ' ')
    .replaceAll(/```[\s\S]*?```/g, ' ')
    .replaceAll(/`[^`\n]*`/g, ' ')
    .replaceAll(/\]\([^)]*\)/g, ']')
    .replaceAll(/<https?:[^>]*>/g, ' ')
    .replaceAll(/https?:\/\/\S+/g, ' ');
}
const sections = (md: string): string[] => [...md.matchAll(/^## (.+)$/gm)].map((m) => m[1] ?? '');

describe('README structure', () => {
  it('has the sections a visitor needs, in order', () => {
    const wanted = [
      'Status now',
      'What each level proves',
      'How it works',
      'Add a quickstart',
      'Badge',
      'Honest limits',
      'Ethics and traffic',
      'Development',
      'License',
    ];
    const have = sections(readme);
    let at = -1;
    for (const s of wanted) {
      const i = have.indexOf(s);
      expect(i, `section "${s}"`).toBeGreaterThan(at);
      at = i;
    }
  });

  it('opens with a one-line hook that says what it is', () => {
    const lines = readme.split('\n');
    const h1 = lines.findIndex((l) => l.startsWith('# '));
    expect(h1).toBe(0);
    const hook = lines.slice(1).find((l) => l.trim() !== '') ?? '';
    expect(hook.length).toBeLessThanOrEqual(220);
    expect(hook).toMatch(/quickstart/i);
    expect(hook).not.toMatch(/\d/);
  });

  it('carries the two generated blocks, once each', () => {
    expect(extractBlock(readme, 'status').length).toBeGreaterThan(20);
    expect(extractBlock(readme, 'detection').length).toBeGreaterThan(20);
  });

  it('draws the architecture in mermaid and names every stage', () => {
    const diagram = /```mermaid\n([\s\S]*?)```/.exec(readme)?.[1] ?? '';
    expect(diagram.length).toBeGreaterThan(50);
    for (const stage of [
      'crawl',
      'compile',
      'ground',
      'execut',
      'classif',
      'status',
      'API',
      'site',
    ])
      expect(diagram, stage).toMatch(new RegExp(stage, 'i'));
  });

  it('links to the methodology, the traffic note, the contribution guide and the disclosure policy, and every relative link exists', () => {
    expect(readme).toContain('quickstartrot.vercel.app/methodology');
    expect(readme).toContain('docs/ABOUT-OUR-TRAFFIC.md');
    expect(readme).toContain('CONTRIBUTING.md');
    expect(readme).toContain('docs/DISCLOSURE.md');
    for (const m of readme.matchAll(/\]\((?!https?:|mailto:|#)([^)\s]+)\)/g))
      expect(exists((m[1] ?? '').split('#')[0] ?? ''), m[1]).toBe(true);
  });
});

describe('README claims', () => {
  it('has no figure typed by hand: every number is in a generated block, a code sample or a link', () => {
    const text = prose(readme);
    const numerals = text.match(/\b\d+(?:\.\d+)?%?/g) ?? [];
    expect(numerals, `numbers typed into the README prose: ${numerals.join(', ')}`).toEqual([]);
    const words =
      text.match(
        /\b(?:two|three|four|five|six|seven|eight|nine|ten|twelve|dozen|hundred|thousand)\b/gi,
      ) ?? [];
    expect(words, `number words typed into the README prose: ${words.join(', ')}`).toEqual([]);
  });

  it('makes no claim of accuracy, coverage or popularity that no document backs', () => {
    const text = prose(readme);
    for (const claim of [
      /\b(?:best|fastest|most accurate|industry[- ]leading|trusted by|used by)\b/i,
      /\bzero false (?:positives|alarms)\b/i,
      /\bcatches? (?:every|all|any) (?:break|failure|bug)/i,
      /\balways (?:right|correct|accurate)\b/i,
    ])
      expect(text).not.toMatch(claim);
  });

  it('says plainly what it does not do', () => {
    const limits = /## Honest limits([\s\S]*?)(?=\n## )/.exec(readme)?.[1] ?? '';
    expect(limits).toMatch(/not a guarantee/i);
    expect(limits).toMatch(/does not measure how often real quickstarts break/i);
    expect(limits).toMatch(/no detection rate|no rate/i);
    expect(limits).toMatch(/model/i);
    expect(limits).toMatch(/Node\.js and Python/);
  });

  it('keeps the ethics promises it makes: robots.txt, no sign-ups, no real keys, an opt-out, and the traffic note', () => {
    const ethics = /## Ethics and traffic([\s\S]*?)(?=\n## )/.exec(readme)?.[1] ?? '';
    expect(ethics).toMatch(/robots\.txt/);
    expect(ethics).toMatch(/sign-?ups?/i);
    expect(ethics).toMatch(/real (?:vendor )?(?:API )?keys?/i);
    expect(ethics).toContain('opt-out');
    expect(ethics).toContain('docs/ABOUT-OUR-TRAFFIC.md');
  });
});

describe('README: how to add a quickstart', () => {
  const yamlBlock = /## Add a quickstart[\s\S]*?```yaml\n([\s\S]*?)```/.exec(readme)?.[1] ?? '';

  it('shows a target file, and the example is valid against the real schema', () => {
    expect(yamlBlock.length).toBeGreaterThan(30);
    const parsed = Target.safeParse(parseYaml(yamlBlock));
    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues)).toBe(true);
  });

  it('says a new target starts disabled and a person turns it on', () => {
    const add = /## Add a quickstart([\s\S]*?)(?=\n## )/.exec(readme)?.[1] ?? '';
    expect(add).toMatch(/enabled: false/);
    expect(add).toMatch(/pull request/i);
    expect(add).toContain('CONTRIBUTING.md');
  });
});

describe('README: license', () => {
  // The licence is the owner's decision. Until a LICENSE file exists the README says none has been chosen; once it exists the README
  // must name it, so the two cannot disagree.
  const section = /## License\n([\s\S]*)$/.exec(readme)?.[1] ?? '';

  it('is consistent with the LICENSE file', () => {
    if (!exists('LICENSE')) {
      expect(section).toMatch(/no licen[cs]e has been chosen/i);
      return;
    }
    const license = readFileSync(path.join(ROOT, 'LICENSE'), 'utf8');
    const named = /MIT License/i.test(license)
      ? /\bMIT\b/
      : /Apache License/i.test(license)
        ? /Apache/i
        : /\[LICENSE\]\(LICENSE\)/;
    expect(section).toMatch(named);
    expect(section).not.toMatch(/no licen[cs]e has been chosen/i);
  });
});
