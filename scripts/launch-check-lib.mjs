// The decisions of scripts/launch-check.mjs, with no network and no file access: what counts as a pass, a fail or a warning. Kept apart
// so each rule is tested (scripts/launch-check-lib.test.mjs). A check returns { status, evidence }: PASS, FAIL, WARN (look at it, it does
// not block), MANUAL (a person has to do it) or SKIP (could not run here, and why).

const MAX_SHARE_IMAGE_BYTES = 5 * 1024 * 1024; // the limit Twitter documents for a card image
const decode = (s) =>
  s
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&#x27;', "'")
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>');

/** The Open Graph and Twitter tags of an HTML page, and its canonical link. */
export function parseMeta(html) {
  const out = {};
  for (const tag of html.match(/<meta\b[^>]*>/g) ?? []) {
    const key = /(?:property|name)="([^"]+)"/.exec(tag)?.[1];
    const content = /content="([^"]*)"/.exec(tag)?.[1];
    if (key !== undefined && content !== undefined && out[key] === undefined)
      out[key] = decode(content);
  }
  const canonical = /<link\b[^>]*rel="canonical"[^>]*>/.exec(html)?.[0];
  const href = canonical === undefined ? undefined : /href="([^"]*)"/.exec(canonical)?.[1];
  if (href !== undefined) out['canonical'] = decode(href);
  return out;
}

/** The width and height in a PNG's header, or null when the bytes are not a PNG. */
export function pngSize(bytes) {
  if (bytes.length < 24) return null;
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!signature.every((b, i) => bytes[i] === b)) return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** What a link to the page unfurls to: a title, a description, and a card image that really is a 1200 by 630 png on our own host. */
export function judgeUnfurl({ siteHost, meta, image }) {
  const problems = [];
  if (!meta['og:title']) problems.push('og:title is missing');
  if (!meta['og:description']) problems.push('og:description is missing');
  if (meta['twitter:card'] !== 'summary_large_image')
    problems.push(`twitter:card is ${meta['twitter:card'] ?? 'missing'}, not summary_large_image`);
  let url = null;
  try {
    url = new URL(meta['og:image'] ?? '');
  } catch {
    problems.push(
      `og:image is ${meta['og:image'] === undefined ? 'missing' : 'not an absolute URL'}`,
    );
  }
  if (url !== null) {
    if (url.protocol !== 'https:') problems.push(`og:image is not https (${url.protocol})`);
    if (url.host !== siteHost) problems.push(`og:image is on ${url.host}, not ${siteHost}`);
  }
  if (url !== null && image !== null) {
    if (image.status !== 200) problems.push(`the image answers ${image.status}`);
    else {
      if (!/^image\/png\b/.test(image.contentType ?? ''))
        problems.push(`the image is ${image.contentType ?? 'untyped'}, not image/png`);
      const size = pngSize(image.bytes);
      if (size === null) problems.push('the image is not a png');
      else if (size.width !== 1200 || size.height !== 630)
        problems.push(`the image is ${size.width}x${size.height}, not 1200x630`);
      if (image.length > MAX_SHARE_IMAGE_BYTES)
        problems.push(`the image is ${image.length} bytes, over 5 MB`);
    }
  }
  if (problems.length > 0) return { status: 'FAIL', evidence: problems.join('; ') };
  const size = pngSize(image.bytes);
  return {
    status: 'PASS',
    evidence: `${meta['og:image']} is a ${size.width}x${size.height} png (${image.length} bytes), twitter:card summary_large_image`,
  };
}

/** The seconds a shared cache may keep a response: s-maxage, else max-age, else null. */
export function cacheSeconds(cacheControl) {
  if (!cacheControl) return null;
  const s = /s-maxage=(\d+)/.exec(cacheControl)?.[1];
  if (s !== undefined) return Number(s);
  const m = /(?:^|[\s,])max-age=(\d+)/.exec(cacheControl)?.[1];
  return m === undefined ? null : Number(m);
}

export function judgeCacheControl(cacheControl, minSeconds) {
  const seconds = cacheSeconds(cacheControl);
  if (!cacheControl || /\b(?:no-store|private)\b/.test(cacheControl))
    return {
      status: 'FAIL',
      evidence: `cache-control is "${cacheControl ?? 'absent'}": not shared-cacheable`,
    };
  if (seconds === null || seconds < minSeconds)
    return {
      status: 'FAIL',
      evidence: `cache-control "${cacheControl}" keeps it ${seconds ?? 0} s, under ${minSeconds} s`,
    };
  return { status: 'PASS', evidence: `cache-control "${cacheControl}"` };
}

/**
 * Whether a CDN keeps a response. Vercel consumes s-maxage and shows the client a bare "public", so the evidence there is a repeat
 * request answered from its cache (x-vercel-cache HIT or STALE, with an age). Without that header, cache-control is all there is.
 * A response marked private or no-store never passes. `responses` are the repeat requests in order.
 */
export function judgeEdgeCache(responses, minSeconds) {
  if (responses.length === 0) return { status: 'FAIL', evidence: 'no response to judge' };
  const unshared = responses.find((r) => /\b(?:no-store|private)\b/.test(r.cacheControl ?? ''));
  if (unshared)
    return {
      status: 'FAIL',
      evidence: `cache-control "${unshared.cacheControl}" is not shared-cacheable`,
    };
  const served = responses.find((r) => /^(?:HIT|STALE)$/.test(r.xVercelCache ?? ''));
  if (served)
    return {
      status: 'PASS',
      evidence: `a repeat request was x-vercel-cache ${served.xVercelCache}, age ${served.age ?? 'unknown'} s`,
    };
  if (responses.some((r) => r.xVercelCache !== undefined && r.xVercelCache !== null))
    return {
      status: 'FAIL',
      evidence: `no repeat request came from the CDN cache (x-vercel-cache ${responses.map((r) => r.xVercelCache).join(', ')})`,
    };
  const last = responses[responses.length - 1];
  return judgeCacheControl(last.cacheControl ?? null, minSeconds);
}

/** Every public page answered 200 inside the limit the first time it was asked after a quiet spell. */
export function judgeColdStart(rows, { maxMs }) {
  if (rows.length === 0) return { status: 'FAIL', evidence: 'nothing was measured' };
  const bad = rows.filter((r) => r.status !== 200 || r.totalMs > maxMs);
  const slowest = rows.reduce((a, b) => (b.totalMs > a.totalMs ? b : a));
  if (bad.length > 0)
    return {
      status: 'FAIL',
      evidence: bad
        .map((r) => `${r.name} ${r.status === 200 ? `${r.totalMs} ms` : `answered ${r.status}`}`)
        .join('; '),
    };
  return {
    status: 'PASS',
    evidence: `${rows.length} requests, slowest ${slowest.name} ${slowest.totalMs} ms (limit ${maxMs} ms)`,
  };
}

/** The needles that appear in the text. A needle shorter than four characters means nothing and is ignored. */
export const findLeaks = (text, needles) =>
  needles.filter((n) => n.length >= 4 && text.includes(n));

/** The newest CI run on main must be a completed success for the commit at the head. */
export function judgeCi(runs, headSha) {
  const run = runs[0];
  if (run === undefined) return { status: 'FAIL', evidence: 'no CI run found' };
  if (run.head_sha !== headSha)
    return {
      status: 'WARN',
      evidence: `the newest CI run is for ${run.head_sha.slice(0, 7)}, not the head ${headSha.slice(0, 7)}`,
    };
  if (run.status !== 'completed')
    return { status: 'WARN', evidence: `CI for the head is ${run.status}: ${run.html_url}` };
  if (run.conclusion !== 'success')
    return { status: 'FAIL', evidence: `CI for the head ${run.conclusion}: ${run.html_url}` };
  return { status: 'PASS', evidence: `CI success for ${headSha.slice(0, 7)}: ${run.html_url}` };
}

/** A burst of requests must be limited (429) before it has been allowed `allowedBeforeLimit` of them. */
export function judgeRateLimit(statuses, { allowedBeforeLimit }) {
  const first = statuses.findIndex((s) => s === 429);
  if (first < 0)
    return {
      status: 'FAIL',
      evidence: `${statuses.length} requests in a burst and none was limited (statuses ${[...new Set(statuses)].join(', ')})`,
    };
  if (first + 1 > allowedBeforeLimit)
    return {
      status: 'FAIL',
      evidence: `the first 429 came at request ${first + 1}, past ${allowedBeforeLimit}`,
    };
  return {
    status: 'PASS',
    evidence: `limited at request ${first + 1} of ${statuses.length} (429)`,
  };
}

// ---- pacing: the check must not be able to knock over the production API

/** The limiter's own advertised state (@fastify/rate-limit sends these on every answer), or null when a header is missing or not a number. */
export function parseRateHeaders(headers) {
  const num = (name) => {
    const v = headers.get(name);
    return v !== null && /^\d+$/.test(v) ? Number(v) : null;
  };
  const limit = num('x-ratelimit-limit');
  const remaining = num('x-ratelimit-remaining');
  const resetS = num('x-ratelimit-reset');
  return limit === null || remaining === null || resetS === null
    ? null
    : { limit, remaining, resetS };
}

/** A limiter exists if it advertises a positive limit and the remaining count goes down request by request. No burst is needed to see that. */
export function judgeRateLimitHeaders(samples) {
  const seen = samples.filter((s) => s !== null);
  if (seen.length === 0)
    return {
      status: 'FAIL',
      evidence: 'the answers carry no x-ratelimit headers: no limiter is advertised',
    };
  const { limit } = seen[0];
  if (!(limit > 0))
    return { status: 'FAIL', evidence: `the limiter advertises a limit of ${limit}` };
  const counts = seen.map((s) => s.remaining);
  const counts_down = counts.length >= 2 && counts.every((c, i) => i === 0 || c < counts[i - 1]);
  if (!counts_down)
    return {
      status: 'FAIL',
      evidence: `the remaining count does not go down across ${counts.length} requests (${counts.join(', ')})`,
    };
  return {
    status: 'PASS',
    evidence: `the limiter advertises ${limit} a minute and counted down ${counts.join(', ')} (no burst needed)`,
  };
}

/**
 * A deliberate burst, if one is wanted at all: one request at a time, no faster than ten a second, never more than the advertised limit plus a
 * few, and none at all when the limit is large (nobody should probe a limit of thousands by exceeding it).
 */
export function burstPlan(limit) {
  const MAX_PROBED_LIMIT = 300;
  if (limit === null || !(limit > 0) || limit > MAX_PROBED_LIMIT)
    return { max: 0, intervalMs: 0, concurrency: 1 };
  return { max: limit + 5, intervalMs: 125, concurrency: 1 };
}

/** Whether GET /health is the shallow one (no database ping), the only kind a burst is allowed against. */
export const shallowHealth = (body) => body !== null && typeof body === 'object' && !('db' in body);

/** How long to wait before a check: a pause between phases, and a longer one before the burst. */
export const pauseBefore = (id, { pauseMs }) =>
  pauseMs === 0 ? 0 : id === 'rate-limit-api' ? Math.max(5000, pauseMs * 4) : pauseMs;

// ---- docs/disclosure-log.md: a record of every private heads-up sent to a vendor, kept by hand (the admin-page tracker is not built)

export const DISCLOSURE_STATUSES = [
  'sent',
  'replied',
  'fixed',
  'disputed',
  'no reply',
  'withdrawn',
];

/** The table of the log as entries, ignoring HTML comments (an example row lives in one) and the separator row. */
export function parseDisclosureLog(md) {
  const text = md.replaceAll(/<!--[\s\S]*?-->/g, '');
  const entries = [];
  let seenHeader = false;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('|')) continue;
    const cells = t
      .replace(/^\||\|$/g, '')
      .split('|')
      .map((c) => c.trim());
    if (!seenHeader) {
      seenHeader = cells.some((c) => /^vendor$/i.test(c));
      continue;
    }
    if (cells.every((c) => /^:?-{2,}:?$/.test(c) || c === '')) continue;
    const [
      vendor = '',
      tool = '',
      failureClass = '',
      channel = '',
      sent = '',
      status = '',
      reply = '',
      notes = '',
    ] = cells;
    entries.push({ vendor, tool, failureClass, channel, sent, status, reply, notes });
  }
  return { entries, saysNoneSent: /none have been sent/i.test(text) };
}

const validDate = (s) =>
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?)?$/.test(s) &&
  !Number.isNaN(Date.parse(s.length === 10 ? `${s}T00:00:00Z` : s));
const sentAt = (s) =>
  Date.parse(s.length === 10 ? `${s}T00:00:00Z` : s.endsWith('Z') ? s : `${s}Z`);

/** PASS only if every entry has a vendor, a valid date sent (not in the future) and a known status. An empty log passes. */
export function judgeDisclosureLog(parsed, { now = Date.now() } = {}) {
  const { entries, saysNoneSent } = parsed;
  if (entries.length === 0)
    return { status: 'PASS', evidence: 'the log is empty: none have been sent' };
  const problems = [];
  if (saysNoneSent) problems.push('the log says none have been sent but has entries');
  for (const [i, e] of entries.entries()) {
    const who = e.vendor || `entry ${i + 1}`;
    if (!e.vendor) problems.push(`entry ${i + 1} has no vendor`);
    if (!validDate(e.sent)) problems.push(`${who}: no valid date sent ("${e.sent}")`);
    else if (sentAt(e.sent) > now + 24 * 3_600_000)
      problems.push(`${who}: the date sent is in the future (${e.sent})`);
    if (e.status === '') problems.push(`${who}: no status`);
    else if (!DISCLOSURE_STATUSES.includes(e.status))
      problems.push(`${who}: unknown status "${e.status}" (use ${DISCLOSURE_STATUSES.join(', ')})`);
  }
  return problems.length === 0
    ? {
        status: 'PASS',
        evidence: `${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}, each with a date sent and a status`,
      }
    : { status: 'FAIL', evidence: problems.join('; ') };
}

/** FAIL while any heads-up (other than a withdrawn one) is still inside its wait: a reply does not shorten it. */
export function judgeDisclosureWindow(parsed, { now = Date.now(), waitHours }) {
  const waiting = parsed.entries
    .filter((e) => e.status !== 'withdrawn' && validDate(e.sent))
    .map((e) => ({ e, ageH: (now - sentAt(e.sent)) / 3_600_000 }))
    .filter((x) => x.ageH < waitHours);
  if (waiting.length === 0)
    return { status: 'PASS', evidence: `no heads-up is inside its ${waitHours} h wait` };
  return {
    status: 'FAIL',
    evidence: waiting
      .map(
        (x) =>
          `${x.e.vendor} (${x.e.tool}): sent ${Math.floor(x.ageH)} h ago, ${Math.ceil(waitHours - x.ageH)} h of the wait left`,
      )
      .join('; '),
  };
}

/** The licence is the owner's decision; the README must say what the LICENSE file says. */
export function judgeLicense({ license, readmeSection }) {
  const none = /no licen[cs]e has been chosen/i.test(readmeSection);
  if (license === null)
    return {
      status: 'FAIL',
      evidence: 'there is no LICENSE file: the owner has not chosen a licence',
    };
  if (none)
    return {
      status: 'FAIL',
      evidence: 'a LICENSE file exists but the README still says no licence has been chosen',
    };
  const named = /MIT License/i.test(license)
    ? /\bMIT\b/
    : /Apache License/i.test(license)
      ? /Apache/i
      : /LICENSE/;
  return named.test(readmeSection)
    ? { status: 'PASS', evidence: 'LICENSE exists and the README names it' }
    : { status: 'FAIL', evidence: 'the README does not name the licence of the LICENSE file' };
}

export const slugsFromSitemap = (xml) =>
  [...xml.matchAll(/\/tools\/([a-z0-9-]+)</g)].map((m) => m[1]);

const STATUSES = ['PASS', 'FAIL', 'WARN', 'MANUAL', 'SKIP'];
/** Counts by status and the exit code: only a FAIL is fatal. */
export function summarise(results) {
  const counts = Object.fromEntries(
    STATUSES.map((s) => [s, results.filter((r) => r.status === s).length]),
  );
  return { counts, exitCode: counts.FAIL > 0 ? 1 : 0 };
}

/** The site tests as many quickstarts at L3 as the target files say reach it in production (the README and /methodology print that number). */
export function judgeL3Count({ testedAtL3, production }) {
  return testedAtL3 === production.length
    ? {
        status: 'PASS',
        evidence: `${testedAtL3} tested at L3 on the site, ${production.length} in the target files (${production.join(', ') || 'none'})`,
      }
    : {
        status: 'FAIL',
        evidence: `the site says ${testedAtL3} tested at L3 but the target files say ${production.length} reach L3 in production (${production.join(', ') || 'none'})`,
      };
}

/**
 * Targets on probation (their file has a `probation` block) are held back by the site until they have two valid cycles. A badge that shows
 * anything but "not tracked" means the site now shows the target: the block should come out of the file so the counts made from the files
 * (claims, the methodology summary, the candidates table) include it. A warning, never a failure: nothing public is wrong.
 */
export function judgeProbation(rows) {
  const released = rows.filter((r) => !/not tracked/i.test(r.badge));
  if (released.length === 0)
    return {
      status: 'PASS',
      evidence:
        rows.length === 0
          ? 'no target is on probation'
          : `${rows.length} on probation, all still held back by the site`,
    };
  return {
    status: 'WARN',
    evidence: `the site now shows ${released.map((r) => r.slug).join(', ')}: remove the probation block from its target file, then run qsr claims, qsr readme and node scripts/render-target-selection.mjs`,
  };
}

/** "X of Y" from the text of the home page's headline h1 (id="headline"), or null when it has none. Reads text, not class names. */
export function headlineFigures(html) {
  const h1 = /<h1[^>]*\bid="headline"[^>]*>([\s\S]*?)<\/h1>/.exec(html);
  if (!h1) return null;
  const m = /(\d+)\s+of\s+(\d+)/.exec(h1[1].replace(/<[^>]*>/g, ' '));
  return m ? { passing: Number(m[1]), tested: Number(m[2]) } : null;
}
