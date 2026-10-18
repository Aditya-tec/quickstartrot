import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  burstPlan,
  cacheSeconds,
  findLeaks,
  judgeCacheControl,
  judgeCi,
  judgeColdStart,
  judgeDisclosureLog,
  judgeDisclosureWindow,
  judgeEdgeCache,
  judgeL3Count,
  judgeLicense,
  judgeRateLimitHeaders,
  judgeRateLimit,
  judgeUnfurl,
  parseDisclosureLog,
  parseMeta,
  parseRateHeaders,
  pauseBefore,
  pngSize,
  shallowHealth,
  slugsFromSitemap,
  summarise,
} from './launch-check-lib.mjs';

// The decisions of scripts/launch-check.mjs, without any network: what counts as a pass, a fail or a warning.

/** The header of a PNG: signature, then IHDR with width and height. */
function png(width, height) {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

test('parseMeta reads Open Graph and Twitter tags in either attribute order, and decodes entities', () => {
  const html = `<head>
    <meta property="og:title" content="Methodology &amp; limits"/>
    <meta content="https://x.test/api/og/methodology" property="og:image"/>
    <meta name="twitter:card" content="summary_large_image"/>
    <meta property="og:description" content="What we &quot;can&quot; see"/>
    <link rel="canonical" href="https://x.test/methodology"/>
  </head>`;
  const m = parseMeta(html);
  assert.equal(m['og:title'], 'Methodology & limits');
  assert.equal(m['og:image'], 'https://x.test/api/og/methodology');
  assert.equal(m['twitter:card'], 'summary_large_image');
  assert.equal(m['og:description'], 'What we "can" see');
  assert.equal(m['canonical'], 'https://x.test/methodology');
  assert.equal(m['og:url'], undefined);
});

test('pngSize reads the size from the header and refuses anything that is not a png', () => {
  assert.deepEqual(pngSize(png(1200, 630)), { width: 1200, height: 630 });
  assert.equal(pngSize(Buffer.from('<html>')), null);
  assert.equal(pngSize(Buffer.alloc(4)), null);
});

const goodMeta = {
  'og:title': 'Methodology',
  'og:description': 'How we test',
  'og:image': 'https://site.test/api/og/methodology',
  'twitter:card': 'summary_large_image',
};
const goodImage = { status: 200, contentType: 'image/png', bytes: png(1200, 630), length: 40_000 };

test('judgeUnfurl passes a page whose image is absolute, on the site, a 1200 by 630 png', () => {
  const r = judgeUnfurl({ siteHost: 'site.test', meta: goodMeta, image: goodImage });
  assert.equal(r.status, 'PASS');
  assert.match(r.evidence, /1200x630/);
});

test('judgeUnfurl fails on a missing, relative, foreign or localhost image, and on the wrong card or size', () => {
  const fail = (meta, image = goodImage) =>
    judgeUnfurl({ siteHost: 'site.test', meta: { ...goodMeta, ...meta }, image });
  assert.equal(fail({ 'og:image': undefined }).status, 'FAIL');
  assert.equal(fail({ 'og:image': '/api/og/home' }).status, 'FAIL');
  assert.equal(fail({ 'og:image': 'http://localhost:3100/api/og/home' }).status, 'FAIL');
  assert.equal(fail({ 'og:image': 'https://other.test/a.png' }).status, 'FAIL');
  assert.equal(fail({ 'twitter:card': 'summary' }).status, 'FAIL');
  assert.equal(fail({ 'og:title': '' }).status, 'FAIL');
  assert.equal(fail({}, { ...goodImage, status: 404 }).status, 'FAIL');
  assert.equal(fail({}, { ...goodImage, contentType: 'text/html' }).status, 'FAIL');
  assert.equal(fail({}, { ...goodImage, bytes: png(600, 315) }).status, 'FAIL');
  assert.equal(fail({}, { ...goodImage, length: 6 * 1024 * 1024 }).status, 'FAIL');
  const named = fail({ 'og:image': undefined });
  assert.match(named.evidence, /og:image/);
});

test('cacheSeconds reads s-maxage first, then max-age, and null when there is none', () => {
  assert.equal(cacheSeconds('public, s-maxage=600, stale-while-revalidate=86400'), 600);
  assert.equal(cacheSeconds('public, max-age=300'), 300);
  assert.equal(cacheSeconds('public, max-age=0, s-maxage=60'), 60);
  assert.equal(cacheSeconds('no-store'), null);
  assert.equal(cacheSeconds(null), null);
});

test('judgeCacheControl needs a public shared cache of at least the stated time', () => {
  assert.equal(
    judgeCacheControl('public, s-maxage=600, stale-while-revalidate=86400', 600).status,
    'PASS',
  );
  assert.equal(judgeCacheControl('public, s-maxage=60', 600).status, 'FAIL');
  assert.equal(judgeCacheControl('no-store', 600).status, 'FAIL');
  assert.equal(judgeCacheControl('private, s-maxage=900', 600).status, 'FAIL');
  assert.equal(judgeCacheControl(null, 600).status, 'FAIL');
});

test('judgeColdStart: every page answers inside the limit, and a slow or failing one is named', () => {
  const rows = [
    { name: 'site /', status: 200, ttfbMs: 1700, totalMs: 2200 },
    { name: 'badge ably-node', status: 200, ttfbMs: 800, totalMs: 810 },
  ];
  assert.equal(judgeColdStart(rows, { maxMs: 5000 }).status, 'PASS');
  const slow = judgeColdStart(
    [...rows, { name: 'site /incidents', status: 200, ttfbMs: 9000, totalMs: 9100 }],
    { maxMs: 5000 },
  );
  assert.equal(slow.status, 'FAIL');
  assert.match(slow.evidence, /site \/incidents/);
  const broken = judgeColdStart([{ name: 'og home', status: 500, ttfbMs: 10, totalMs: 10 }], {
    maxMs: 5000,
  });
  assert.equal(broken.status, 'FAIL');
  assert.match(broken.evidence, /og home.*500/);
  assert.equal(judgeColdStart([], { maxMs: 5000 }).status, 'FAIL');
});

test('findLeaks names each needle that appears in a text, and ignores short or empty needles', () => {
  assert.deepEqual(
    findLeaks('a TypeError: x is not a function b', ['TypeError: x is not a function', 'nope']),
    ['TypeError: x is not a function'],
  );
  assert.deepEqual(findLeaks('anything', ['', 'ab']), []); // too short to mean anything
  assert.deepEqual(findLeaks('', ['long needle here']), []);
});

test('judgeCi passes only a completed success for the commit at the head', () => {
  const run = (over) => ({
    head_sha: 'abc',
    status: 'completed',
    conclusion: 'success',
    html_url: 'u',
    ...over,
  });
  assert.equal(judgeCi([run({})], 'abc').status, 'PASS');
  assert.equal(judgeCi([run({ conclusion: 'failure' })], 'abc').status, 'FAIL');
  assert.equal(judgeCi([run({ status: 'in_progress', conclusion: null })], 'abc').status, 'WARN');
  // the newest run is for an older commit: the head has not been checked
  assert.equal(judgeCi([run({ head_sha: 'old' })], 'abc').status, 'WARN');
  assert.equal(judgeCi([], 'abc').status, 'FAIL');
});

test('judgeRateLimit passes when a burst is answered with 429 before the cap, and fails when nothing ever limits it', () => {
  const ok = Array.from({ length: 130 }, () => 200).concat([429, 429]);
  assert.equal(judgeRateLimit(ok, { allowedBeforeLimit: 200 }).status, 'PASS');
  assert.match(judgeRateLimit(ok, { allowedBeforeLimit: 200 }).evidence, /131/);
  assert.equal(
    judgeRateLimit(
      Array.from({ length: 220 }, () => 200),
      { allowedBeforeLimit: 200 },
    ).status,
    'FAIL',
  );
  assert.equal(
    judgeRateLimit([429].concat(Array.from({ length: 10 }, () => 200)), { allowedBeforeLimit: 200 })
      .status,
    'PASS',
  );
  // a server error is not a limit
  assert.equal(judgeRateLimit([500, 500, 500], { allowedBeforeLimit: 200 }).status, 'FAIL');
});

test('judgeLicense fails without a LICENSE file and passes with a named one', () => {
  assert.equal(
    judgeLicense({ license: null, readmeSection: 'No licence has been chosen yet' }).status,
    'FAIL',
  );
  assert.equal(
    judgeLicense({
      license: 'MIT License\n\nCopyright',
      readmeSection: 'Released under the MIT licence',
    }).status,
    'PASS',
  );
  assert.equal(
    judgeLicense({ license: 'MIT License', readmeSection: 'No licence has been chosen yet' })
      .status,
    'FAIL',
  );
});

test('slugsFromSitemap lists the tool slugs in order', () => {
  const xml =
    '<loc>https://s.test/</loc><loc>https://s.test/tools/a-node</loc><loc>https://s.test/tools/b-python</loc>';
  assert.deepEqual(slugsFromSitemap(xml), ['a-node', 'b-python']);
  assert.deepEqual(slugsFromSitemap('<loc>https://s.test/</loc>'), []);
});

test('summarise exits non-zero only for a failure; warnings and manual items are listed, not fatal', () => {
  const r = summarise([
    { id: 'a', status: 'PASS', evidence: '' },
    { id: 'b', status: 'WARN', evidence: '' },
    { id: 'c', status: 'MANUAL', evidence: '' },
    { id: 'd', status: 'SKIP', evidence: '' },
  ]);
  assert.equal(r.exitCode, 0);
  assert.deepEqual(r.counts, { PASS: 1, FAIL: 0, WARN: 1, MANUAL: 1, SKIP: 1 });
  const bad = summarise([{ id: 'x', status: 'FAIL', evidence: '' }]);
  assert.equal(bad.exitCode, 1);
});

// Vercel consumes s-maxage and shows the client a bare "public"; whether the CDN really cached a response is in x-vercel-cache and age.
test('judgeEdgeCache passes when the CDN served a repeat request from its cache, whatever cache-control shows the client', () => {
  const miss = { cacheControl: 'public', xVercelCache: 'MISS', age: '0' };
  assert.equal(
    judgeEdgeCache([miss, { cacheControl: 'public', xVercelCache: 'HIT', age: '3' }], 600).status,
    'PASS',
  );
  assert.equal(
    judgeEdgeCache([miss, { cacheControl: 'public', xVercelCache: 'STALE', age: '1400' }], 600)
      .status,
    'PASS',
  );
  const hit = judgeEdgeCache(
    [miss, { cacheControl: 'public', xVercelCache: 'HIT', age: '3' }],
    600,
  );
  assert.match(hit.evidence, /HIT/);
  assert.match(hit.evidence, /age 3/);
});

test('judgeEdgeCache fails when a repeat request is never served from the cache', () => {
  const miss = { cacheControl: 'public', xVercelCache: 'MISS', age: '0' };
  const r = judgeEdgeCache([miss, miss, miss], 600);
  assert.equal(r.status, 'FAIL');
  assert.match(r.evidence, /MISS/);
});

test('judgeEdgeCache without a CDN header falls back on cache-control, as before', () => {
  assert.equal(
    judgeEdgeCache(
      [{ cacheControl: 'public, s-maxage=600' }, { cacheControl: 'public, s-maxage=600' }],
      600,
    ).status,
    'PASS',
  );
  assert.equal(
    judgeEdgeCache([{ cacheControl: 'public' }, { cacheControl: 'public' }], 600).status,
    'FAIL',
  );
  assert.equal(judgeEdgeCache([], 600).status, 'FAIL');
});

test('judgeEdgeCache never accepts a private or no-store response, even from the CDN cache', () => {
  assert.equal(
    judgeEdgeCache([{ cacheControl: 'private, no-store', xVercelCache: 'HIT', age: '2' }], 600)
      .status,
    'FAIL',
  );
});

// Pacing. The check must not be able to knock over the production API (it did, twice, on 2026-10-18: a 20-wide burst of GET /health, each one
// a database ping, delayed Render's own health probe). The burst is sequential, bounded by the limit the limiter itself advertises, and
// refused against a /health that still pings the database.
test('parseRateHeaders reads the limiter headers, and nothing else', () => {
  const h = new Headers({
    'x-ratelimit-limit': '120',
    'x-ratelimit-remaining': '117',
    'x-ratelimit-reset': '41',
  });
  assert.deepEqual(parseRateHeaders(h), { limit: 120, remaining: 117, resetS: 41 });
  assert.equal(parseRateHeaders(new Headers()), null);
  assert.equal(parseRateHeaders(new Headers({ 'x-ratelimit-limit': 'many' })), null);
});

test('judgeRateLimitHeaders passes a limiter that advertises a limit and counts down, without any burst', () => {
  const r = judgeRateLimitHeaders([
    { limit: 120, remaining: 119, resetS: 59 },
    { limit: 120, remaining: 118, resetS: 59 },
    { limit: 120, remaining: 117, resetS: 58 },
  ]);
  assert.equal(r.status, 'PASS');
  assert.match(r.evidence, /120 a minute/);
  assert.match(r.evidence, /no burst/);
});

test('judgeRateLimitHeaders fails when there are no headers or the count does not move', () => {
  assert.equal(judgeRateLimitHeaders([null, null]).status, 'FAIL');
  assert.equal(judgeRateLimitHeaders([]).status, 'FAIL');
  const stuck = judgeRateLimitHeaders([
    { limit: 120, remaining: 119, resetS: 59 },
    { limit: 120, remaining: 119, resetS: 59 },
  ]);
  assert.equal(stuck.status, 'FAIL');
  assert.equal(judgeRateLimitHeaders([{ limit: 0, remaining: 0, resetS: 1 }]).status, 'FAIL');
});

test('burstPlan never sends more than the limit plus a few, one at a time, no faster than ten a second', () => {
  const p = burstPlan(120);
  assert.equal(p.max, 125);
  assert.ok(p.intervalMs >= 100);
  assert.equal(p.concurrency, 1);
  // a limit nobody should probe by exceeding it is not probed
  assert.equal(burstPlan(100_000).max, 0);
  assert.equal(burstPlan(301).max, 0);
  assert.equal(burstPlan(300).max, 305);
  assert.equal(burstPlan(null).max, 0);
});

test('shallowHealth says whether /health still pings the database', () => {
  assert.equal(shallowHealth({ status: 'ok', time: 'x' }), true);
  assert.equal(shallowHealth({ status: 'ok', db: true, time: 'x' }), false);
  assert.equal(shallowHealth(null), false);
});

test('pauses: a pause between phases, longer before the burst', () => {
  assert.equal(pauseBefore('site-reachable', { pauseMs: 1500 }), 1500);
  assert.ok(pauseBefore('rate-limit-api', { pauseMs: 1500 }) >= 5000);
  assert.equal(pauseBefore('site-reachable', { pauseMs: 0 }), 0);
});

// docs/disclosure-log.md: a record, kept by hand, of every private heads-up sent to a vendor. Disclosure tracking inside the admin page is
// not built, so the launch check reads this file. An empty log passes (none have been sent); every entry needs a date sent and a status.
const HEADER = `# Disclosure log

None have been sent.

<!-- an example row, not an entry:
| Acme | acme-node | API_DRIFT | support form | 2026-10-01 | sent | | |
-->

| Vendor | Tool (slug) | Failure class | Sent to (channel) | Date sent (UTC) | Status | Reply | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
`;
const NOW = Date.parse('2026-10-20T12:00:00Z');
const WAIT_H = 48;
const log = (...rows) =>
  HEADER.replace(
    'None have been sent.\n',
    rows.length > 0 ? 'Some have been sent.\n' : 'None have been sent.\n',
  ) +
  rows.join('\n') +
  '\n';

test('parseDisclosureLog reads the table, ignores comments and the separator row, and notes whether it says none were sent', () => {
  const empty = parseDisclosureLog(log());
  assert.deepEqual(empty.entries, []);
  assert.equal(empty.saysNoneSent, true);
  const two = parseDisclosureLog(
    log(
      '| Acme | acme-node | API_DRIFT | support form | 2026-10-01 | sent | | |',
      '| Beta | beta-python | DOCS_SNIPPET_ERROR | docs email | 2026-10-05 | fixed | fixed in 3 h | |',
    ),
  );
  assert.equal(two.entries.length, 2);
  assert.equal(two.entries[0].vendor, 'Acme');
  assert.equal(two.entries[1].status, 'fixed');
  assert.equal(two.saysNoneSent, false);
});

test('an empty log passes, and says so', () => {
  const r = judgeDisclosureLog(parseDisclosureLog(log()));
  assert.equal(r.status, 'PASS');
  assert.match(r.evidence, /none have been sent/i);
});

test('every entry with a date sent and a status passes', () => {
  const r = judgeDisclosureLog(
    parseDisclosureLog(
      log(
        '| Acme | acme-node | API_DRIFT | support form | 2026-10-01 | sent | | |',
        '| Beta | beta-python | API_DRIFT | email | 2026-10-05T09:30:00Z | no reply | | asked twice |',
      ),
    ),
  );
  assert.equal(r.status, 'PASS');
  assert.match(r.evidence, /2 entries/);
});

test('an entry without a date sent, with a date that is not one, in the future, without a status, with an unknown one, or without a vendor fails and is named', () => {
  const bad = (row, expected) => {
    const r = judgeDisclosureLog(parseDisclosureLog(log(row)), { now: NOW });
    assert.equal(r.status, 'FAIL', row);
    assert.match(r.evidence, expected, row);
  };
  bad('| Acme | acme-node | API_DRIFT | form | | sent | | |', /Acme.*date sent/i);
  bad('| Acme | acme-node | API_DRIFT | form | last week | sent | | |', /Acme.*date sent/i);
  bad('| Acme | acme-node | API_DRIFT | form | 2026-13-45 | sent | | |', /Acme.*date sent/i);
  bad('| Acme | acme-node | API_DRIFT | form | 2027-01-01 | sent | | |', /Acme.*future/i);
  bad('| Acme | acme-node | API_DRIFT | form | 2026-10-01 | | | |', /Acme.*status/i);
  bad('| Acme | acme-node | API_DRIFT | form | 2026-10-01 | maybe | | |', /Acme.*status.*maybe/i);
  bad('| | acme-node | API_DRIFT | form | 2026-10-01 | sent | | |', /vendor/i);
});

test('a log that says none were sent but has entries contradicts itself', () => {
  const md = HEADER + '| Acme | acme-node | API_DRIFT | form | 2026-10-01 | sent | | |\n';
  const r = judgeDisclosureLog(parseDisclosureLog(md));
  assert.equal(r.status, 'FAIL');
  assert.match(r.evidence, /says none have been sent/i);
});

test('judgeDisclosureWindow fails for a heads-up still inside its wait, whatever its status, and passes once the wait has passed', () => {
  const hoursAgo = (h) => new Date(NOW - h * 3_600_000).toISOString().slice(0, 19) + 'Z';
  const row = (h, status) =>
    `| Acme | acme-node | API_DRIFT | form | ${hoursAgo(h)} | ${status} | | |`;
  const w = (h, status) =>
    judgeDisclosureWindow(parseDisclosureLog(log(row(h, status))), { now: NOW, waitHours: WAIT_H });
  assert.equal(w(10, 'sent').status, 'FAIL');
  assert.match(w(10, 'sent').evidence, /Acme.*38 h/);
  assert.equal(w(1, 'replied').status, 'FAIL'); // a reply does not shorten the wait
  assert.equal(w(48, 'sent').status, 'PASS'); // exactly the wait has passed
  assert.equal(w(60, 'sent').status, 'PASS');
  assert.equal(w(5, 'withdrawn').status, 'PASS'); // withdrawn: nothing is pending
  assert.equal(
    judgeDisclosureWindow(parseDisclosureLog(log()), { now: NOW, waitHours: WAIT_H }).status,
    'PASS',
  );
});

test('judgeL3Count passes when the site tests as many quickstarts at L3 as the target files say reach it, and names the difference otherwise', () => {
  const ok = judgeL3Count({
    testedAtL3: 3,
    production: ['anthropic-node', 'anthropic-python', 'resend-node'],
  });
  assert.equal(ok.status, 'PASS');
  assert.match(ok.evidence, /3/);
  const off = judgeL3Count({ testedAtL3: 2, production: ['a', 'b', 'c'] });
  assert.equal(off.status, 'FAIL');
  assert.match(off.evidence, /site says 2.*3 reach L3/);
  assert.equal(judgeL3Count({ testedAtL3: 0, production: [] }).status, 'PASS');
});
