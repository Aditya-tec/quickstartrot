import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { OPT_OUT, optOutSentences, PIPELINE } from '@qsr/core';
import { renderPromiseBlock } from './readme-command.js';

// What an opt-out does (the owner's decision of 2026-10-19), said exactly the same way everywhere a vendor, or anyone, can read it:
//   1. probing stops within 24 hours of an opt-out request;
//   2. the quickstart's page stays up, labelled "no longer monitored at the vendor's request";
//   3. past results stay visible and are hidden only if the vendor asks for that.
// The three sentences come from `optOutSentences()` in @qsr/core. The vendor form, the disclosure policy, the traffic note, the email
// template, the README and the claims sheet must each contain them word for word, and none may still say the history is hidden by default.
// The website's /bot and /methodology are held to the same sentences in apps/web (bot-content.test.tsx, methodology-content.test.tsx).

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), 'utf8');

interface Form {
  description: string;
  body: { type: string; attributes?: { value?: string; options?: unknown[] } }[];
}
const form = parseYaml(read('.github/ISSUE_TEMPLATE/opt-out.yml')) as Form;
const formText = [
  form.description,
  ...form.body.map((b) => b.attributes?.value ?? ''),
  ...form.body.flatMap((b) => (b.attributes?.options ?? []).map(String)),
].join('\n');

const SURFACES: { name: string; text: string }[] = [
  { name: 'the vendor form (.github/ISSUE_TEMPLATE/opt-out.yml)', text: formText },
  { name: 'docs/DISCLOSURE.md', text: read('docs/DISCLOSURE.md') },
  { name: 'docs/ABOUT-OUR-TRAFFIC.md', text: read('docs/ABOUT-OUR-TRAFFIC.md') },
  { name: 'docs/templates/disclosure-email.md', text: read('docs/templates/disclosure-email.md') },
  { name: 'README.md', text: read('README.md') },
  { name: 'docs/CLAIMS.md', text: read('docs/CLAIMS.md') },
];

// Markdown may wrap a sentence over two lines; the words stay the same.
const flat = (text: string): string => text.replace(/\s+/g, ' ');

describe('what an opt-out does, in the words of optOutSentences()', () => {
  const s = optOutSentences();

  it('is the owner’s decision: 24 hours, the label, and history hidden on request only', () => {
    expect(s.probing).toBe('Probing stops within 24 hours of an opt-out request.');
    expect(s.label).toBe(
      'The quickstart\'s page stays up, labelled "no longer monitored at the vendor\'s request".',
    );
    expect(s.history).toBe(
      'Past results stay visible and are hidden only if the vendor asks for that.',
    );
    expect(OPT_OUT.pageLabel).toBe("No longer monitored at the vendor's request");
  });

  for (const surface of SURFACES) {
    it(`${surface.name} says all three, word for word`, () => {
      const text = flat(surface.text);
      expect(text).toContain(s.probing);
      expect(text).toContain(s.label);
      expect(text).toContain(s.history);
    });

    it(`${surface.name} no longer says the history is hidden by default`, () => {
      const text = flat(surface.text);
      expect(text).not.toMatch(/and the (tool's )?history is hidden/i);
      expect(text).not.toMatch(/probing stops, and the history is hidden/i);
      expect(text).not.toMatch(/stop testing and hide the history/i);
      expect(text).not.toMatch(/history is hidden at the same time/i);
    });
  }

  it('the README promise block is generated from the same sentences, and keeps the written reply', () => {
    const block = renderPromiseBlock();
    expect(block).toContain(s.probing);
    expect(block).toContain(s.label);
    expect(block).toContain(s.history);
    expect(block).toContain(
      `We reply in writing within ${PIPELINE.vendorReplyBusinessDays} business days.`,
    );
  });

  it('the vendor form lets the vendor say whether the past results should be hidden, as a separate choice from stopping', () => {
    const options = form.body.flatMap((b) => (b.attributes?.options ?? []).map(String));
    expect(options.some((o) => /^Opt out - stop testing$/i.test(o))).toBe(true);
    expect(options.some((o) => /opt out.*also hide the past results/i.test(o))).toBe(true);
  });

  it('a changed number changes every sentence: the hours are read from the pipeline constant, never typed', () => {
    expect(optOutSentences(48).probing).toBe(
      'Probing stops within 48 hours of an opt-out request.',
    );
    expect(optOutSentences(48).label).toBe(s.label);
    expect(optOutSentences(48).history).toBe(s.history);
  });
});
