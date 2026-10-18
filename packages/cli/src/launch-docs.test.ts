import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { PIPELINE, VENDOR_FAILURE_CLASSES } from '@qsr/core';

// The launch kit: contribution mechanics, the disclosure policy and its email, the walkthrough and the checklist. Each says something
// the code has to make true, so each is pinned to the constants (PIPELINE) or to the files it points at. Nothing here is sent anywhere.

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel: string): boolean => existsSync(path.join(ROOT, rel));
const headings = (md: string): string[] =>
  [...md.matchAll(/^#{1,3} (.+)$/gm)].map((m) => (m[1] ?? '').trim());
/** Every relative markdown link of a document that lives in `dir`, as a path from the repository root, without its #anchor. */
const relativeLinks = (md: string, dir = ''): string[] =>
  [...md.matchAll(/\]\((?!https?:|mailto:|#)([^)\s]+)\)/g)].map((m) =>
    path.posix.normalize(path.posix.join(dir, (m[1] ?? '').split('#')[0] ?? '')),
  );

interface Form {
  name: string;
  description: string;
  title?: string;
  labels?: string[];
  body: {
    type: string;
    id?: string;
    attributes?: { label?: string; value?: string; options?: unknown[] };
    validations?: { required?: boolean };
  }[];
}
const form = (file: string): Form => parseYaml(read(`.github/ISSUE_TEMPLATE/${file}`)) as Form;

describe('issue template: Add a quickstart', () => {
  const f = form('submit-quickstart.yml');
  it('is named for what it does, and points at CONTRIBUTING', () => {
    expect(f.name).toBe('Add a quickstart');
    const text = JSON.stringify(f);
    expect(text).toContain('CONTRIBUTING.md');
    expect(f.labels).toContain('submission');
  });

  it('asks for the docs URL and the language, and for how it will be added', () => {
    const byId = (id: string) => f.body.find((b) => b.id === id);
    expect(byId('docs-url')?.validations?.required).toBe(true);
    expect(byId('language')?.attributes?.options).toEqual(['Node.js', 'Python']);
    expect(byId('how')?.attributes?.options?.length).toBeGreaterThanOrEqual(2);
  });

  it('makes the submitter confirm the rules we accept a quickstart under', () => {
    const boxes = f.body.find((b) => b.type === 'checkboxes');
    const text = JSON.stringify(boxes);
    expect(boxes).toBeDefined();
    for (const rule of [/public/i, /sign-up|sign up/i, /terms/i, /person/i])
      expect(text).toMatch(rule);
  });
});

describe('issue template: Vendor: question or opt-out', () => {
  const f = form('opt-out.yml');
  const text = JSON.stringify(f);

  it('is named for vendors, and the form has not moved (the /bot page links to opt-out.yml)', () => {
    expect(f.name).toBe('Vendor: question or opt-out');
    expect(f.labels).toContain('vendor');
    expect(read('apps/web/src/components/bot-content.tsx')).toContain('template=opt-out.yml');
  });

  // The owner's decision of 2026-10-18: probing stops within 24 hours of an opt-out request; a written reply within 3 business days.
  it('promises, in the description and in the form, that probing stops within the hours the pipeline says and a written reply follows within its business days', () => {
    const hours = `${PIPELINE.optOutHours} hours`;
    const days = `${PIPELINE.vendorReplyBusinessDays} business days`;
    expect(f.description).toContain(`Probing stops within ${hours} of an opt-out request`);
    expect(f.description).toContain(`written reply within ${days}`);
    const intro = f.body.find((b) => b.type === 'markdown')?.attributes?.value ?? '';
    expect(intro).toContain(
      `Probing of your quickstart stops within ${hours} of an opt-out request`,
    );
    expect(intro).toContain(`We reply in writing within ${days}`);
    // the old promise, a reply in 24 hours, is gone
    expect(JSON.stringify(f)).not.toMatch(/reply[^.]*within 24 hours/i);
  });

  it('lets a vendor say what they need: a question, an opt-out, a correction, or something else', () => {
    const need = f.body.find((b) => b.id === 'need');
    expect(need?.validations?.required).toBe(true);
    const options = (need?.attributes?.options ?? []).map(String);
    expect(options.some((o) => /question/i.test(o))).toBe(true);
    expect(options.some((o) => /opt out|stop/i.test(o))).toBe(true);
    expect(options.some((o) => /wrong|correction/i.test(o))).toBe(true);
    expect(options.some((o) => /else|other/i.test(o))).toBe(true);
  });

  it('tells a vendor what we send them and how we handle a failure, with links that exist', () => {
    expect(text).toContain('ABOUT-OUR-TRAFFIC.md');
    expect(text).toContain('DISCLOSURE.md');
    expect(exists('docs/ABOUT-OUR-TRAFFIC.md')).toBe(true);
    expect(exists('docs/DISCLOSURE.md')).toBe(true);
  });

  it('warns not to paste secrets into a public issue', () => {
    expect(text).toMatch(/do not paste secrets/i);
  });
});

describe('CONTRIBUTING.md', () => {
  const md = read('CONTRIBUTING.md');

  it('explains how to add a quickstart: the target file, validation, a disabled start, and a pull request', () => {
    expect(headings(md)).toContain('Add a quickstart');
    expect(md).toContain('targets/');
    expect(md).toContain('pnpm qsr validate');
    expect(md).toMatch(/enabled: false/);
    expect(md).toMatch(/pull request/i);
    expect(md).toMatch(/Add a quickstart.*issue|issue.*Add a quickstart/is);
  });

  it('states the rules a quickstart must meet, the same ones /methodology states', () => {
    expect(md).toMatch(/robots\.txt/);
    expect(md).toMatch(/Node\.js or Python/);
    expect(md).toMatch(/sign-up/i);
    expect(md).toMatch(/terms/i);
    expect(md).toMatch(/real users/i);
    const methodology = read('apps/web/src/components/methodology-content.tsx');
    for (const rule of [
      'robots.txt',
      'Node.js or Python',
      'sign-up',
      'terms of service',
      'real users',
    ])
      expect(methodology, rule).toContain(rule);
  });

  it('keeps the trust rules a change must not break', () => {
    expect(md).toMatch(/never writes code/i);
    expect(md).toMatch(/no secret/i);
    expect(md).toContain('AGENTS.md');
  });

  it('says how to report a wrong result and how a vendor asks us to stop', () => {
    expect(md).toContain('opt-out.yml');
    expect(md).toMatch(/wrong result/i);
  });

  it('links only to files that exist', () => {
    for (const link of relativeLinks(md)) expect(exists(link), link).toBe(true);
  });
});

describe('docs/DISCLOSURE.md', () => {
  const md = read('docs/DISCLOSURE.md');

  it('states the policy: private first, the wait in hours from the code, then public only after a person reviewed it', () => {
    expect(md).toMatch(/private heads-up/i);
    expect(md).toContain(`${PIPELINE.disclosureWaitHours} hours`);
    expect(md).toMatch(/human review|a person reviews/i);
    expect(md).toMatch(/nothing is public/i);
  });

  it('says a transient or infrastructure failure is never made public, and names the class list the review screen enforces', () => {
    expect(md).toMatch(/never public for a transient or infrastructure failure/i);
    for (const cls of [
      'NETWORK_TRANSIENT',
      'TIMEOUT',
      'CRAWL_ERROR',
      'COMPILER_ERROR',
      'HARNESS_ERROR',
    ])
      expect(md, cls).toContain(cls);
    for (const cls of VENDOR_FAILURE_CLASSES) expect(md, cls).toContain(cls);
    expect(md).toContain('confirmIncident');
  });

  it('says what the vendor can do: reply, fix, dispute, or opt out, with the promised hours and the written reply', () => {
    expect(md).toContain(
      `Probing stops within ${PIPELINE.optOutHours} hours of an opt-out request`,
    );
    expect(md).toContain(`written reply within ${PIPELINE.vendorReplyBusinessDays} business days`);
    expect(md).toContain('opt-out.yml');
    expect(md).toMatch(/dispute|disagree/i);
  });

  it('points at the email template, and sends nothing from this repository', () => {
    expect(md).toContain('docs/templates/disclosure-email.md');
    expect(md).toMatch(/nothing in this repository sends/i);
  });

  it('links only to files that exist', () => {
    for (const link of relativeLinks(md, 'docs')) expect(exists(link), link).toBe(true);
  });
});

describe('docs/templates/disclosure-email.md', () => {
  const md = read('docs/templates/disclosure-email.md');

  it('is a template with named placeholders for everything that differs, and no address or secret', () => {
    for (const p of [
      'vendor',
      'tool_name',
      'docs_url',
      'run_link',
      'failing_line',
      'first_failed_at',
      'sender_name',
    ])
      expect(md, p).toContain(`{{${p}}}`);
    expect(md).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/); // no email address
    expect(md).not.toMatch(/(?:sk|pk|ghp|xox[bp])[-_][A-Za-z0-9]{10,}/); // no key
  });

  it('is a private heads-up: it says nothing is public yet and states the wait and the opt-out in hours', () => {
    expect(md).toMatch(/nothing about this is public/i);
    expect(md).toContain(`${PIPELINE.disclosureWaitHours} hours`);
    expect(md).toContain(
      `probing stops, and the history is hidden, within ${PIPELINE.optOutHours} hours of an opt-out request`,
    );
    expect(md).toContain(`written reply within ${PIPELINE.vendorReplyBusinessDays} business days`);
    expect(md).toMatch(/you do not need to reply/i);
  });

  it('is neutral: evidence and an offer, no threat, no claim of fault, no request for anything', () => {
    expect(md).not.toMatch(
      /\b(?:expose|shame|publicly call|we will name you|or else|failure to respond)\b/i,
    );
    expect(md).toMatch(/no affiliation/i);
    expect(md).toMatch(/might be wrong|may be wrong|tell us if we are wrong/i);
  });

  it('states what was tested and how, so the vendor can reproduce it', () => {
    expect(md).toMatch(/fresh|clean/i);
    expect(md).toMatch(/verbatim|exactly as/i);
    expect(md).toContain('{{docs_url}}');
  });

  it('is marked as never sent from the repository', () => {
    expect(md).toMatch(/not sent by any code/i);
  });
});

describe('docs/WALKTHROUGH.md', () => {
  const md = read('docs/WALKTHROUGH.md');
  const beats = [...md.matchAll(/^\| (\d):(\d\d)-(\d):(\d\d) \|/gm)].map((m) => ({
    from: Number(m[1]) * 60 + Number(m[2]),
    to: Number(m[3]) * 60 + Number(m[4]),
  }));

  it('is a script of timed beats that run in order, without a gap, and end inside a minute', () => {
    expect(beats.length).toBeGreaterThanOrEqual(5);
    expect(beats[0]?.from).toBe(0);
    for (let i = 1; i < beats.length; i += 1) expect(beats[i]?.from).toBe(beats[i - 1]?.to);
    expect(beats[beats.length - 1]?.to).toBeLessThanOrEqual(60);
  });

  it('shows the pages in an order that tells the story, and every page it names exists', () => {
    const order = ['/', '/tools/', '/runs/', '/methodology#detection', '/submit'];
    let at = -1;
    for (const p of order) {
      const i = md.indexOf(`\`${p}`);
      expect(i, p).toBeGreaterThan(at);
      at = i;
    }
    const pages = read('apps/web/e2e/pages.ts');
    for (const p of ['/methodology', '/submit', '/incidents'] as const) expect(pages).toContain(p);
  });

  it('is text only and quotes no number: the presenter reads each one off the screen', () => {
    const prose = md
      .replaceAll(/^\| \d:\d\d-\d:\d\d \|/gm, '|')
      .replaceAll(/`[^`]*`/g, '')
      .replaceAll(/\]\([^)]*\)/g, ']');
    expect(prose.match(/\b\d+\b/g) ?? []).toEqual([]);
    expect(md).toMatch(/read the number off the screen/i);
  });

  it('says what never to show: the admin pages, a token, an unreviewed failure', () => {
    expect(md).toMatch(/do not show/i);
    expect(md).toMatch(/\/admin/);
    expect(md).toMatch(/token/i);
    expect(md).toMatch(/verifying/i);
  });
});
