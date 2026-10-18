import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cacheSeconds,
  findLeaks,
  judgeCacheControl,
  judgeCi,
  judgeColdStart,
  judgeLicense,
  judgeRateLimit,
  judgeUnfurl,
  parseMeta,
  pngSize,
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
