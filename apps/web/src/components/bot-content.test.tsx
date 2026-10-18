import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BotContent } from './bot-content';
import { FACTS, words } from '@/lib/facts';

// "About our traffic": which services get a request with an invalid credential, how often, from where, that nothing is created or sent,
// how to ask us to stop, and when the terms were read (and that it was a summary, not legal advice). Names only say where traffic goes.

const traffic = {
  services: [{ name: 'Alpha' }, { name: 'Beta' }, { name: 'Gamma' }],
  termsReviewedOn: '2026-10-18',
};
const html = (over: { email?: string | null } = {}): string =>
  renderToStaticMarkup(
    <BotContent
      facts={FACTS}
      userAgent="QuickstartRotBot/1.0 (+https://example.test/bot)"
      email={over.email === undefined ? 'bot@example.test' : over.email}
      traffic={traffic}
    />,
  )
    .replaceAll(/<[^>]+>/g, ' ')
    .replaceAll('&#x27;', "'")
    .replaceAll(/\s+/g, ' ');

describe('/bot: About our traffic', () => {
  it('has the section, and names every service in plain words with "and"', () => {
    const t = html();
    expect(t).toContain('About our traffic');
    expect(t).toContain('Alpha, Beta and Gamma');
  });

  it("says what the request is: invalid on purpose, refused, from GitHub Actions, with the library's own user agent", () => {
    const t = html();
    expect(t).toMatch(/invalid, made-up credential/);
    expect(t).toMatch(/docs set no key, the request carries none at all/);
    expect(t).toMatch(/GitHub Actions/);
    expect(t).toMatch(/the library's own user agent|library's user agent/i);
  });

  it('says how often, from the facts: a request per quickstart per cycle and a daily maximum', () => {
    const t = html();
    expect(t).toMatch(new RegExp(`at most \\w+ requests? per cycle`, 'i'));
    expect(t).toMatch(/a day/i);
  });

  it('says nothing is created, sent or charged and that we never hold a real key', () => {
    const t = html();
    expect(t).toMatch(/cannot create, send or charge anything/);
    expect(t).toMatch(/never hold a real/i);
  });

  it('gives a way to ask us to stop (the opt-out form, and the address when there is one)', () => {
    expect(html()).toMatch(/ask us to stop/i);
    expect(html()).toContain('bot@example.test');
    expect(html({ email: null })).toMatch(/opt-out form/i);
  });

  // The promise, from the facts: probing stops within a day of an opt-out request; a written reply within three business days.
  it('promises that probing stops within 24 hours of an opt-out request and a written reply within three business days', () => {
    const t = html();
    expect(t).toContain(`Probing stops within ${FACTS.optOutHours} hours of an opt-out request`);
    expect(t).toContain(
      `reply in writing within ${words(FACTS.vendorReplyBusinessDays)} business days`,
    );
  });

  it('says when the terms were read, that it was a summary and not legal advice, and implies no affiliation or endorsement', () => {
    const t = html();
    expect(t).toContain('18 October 2026');
    expect(t).toMatch(/summary/i);
    expect(t).toMatch(/not legal advice/i);
    expect(t).toMatch(/no affiliation with, or endorsement by/i);
  });
});
