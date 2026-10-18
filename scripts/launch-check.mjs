#!/usr/bin/env node
// `node --env-file=.env scripts/launch-check.mjs`: the launch gate (docs/LAUNCH-CHECKLIST.md), run the day before. Every check that can be
// automated is here, and each prints PASS, FAIL, WARN, MANUAL or SKIP with the evidence. Only a FAIL is fatal (exit 1).
//
//   --site <url>     the website (default https://quickstartrot.vercel.app)
//   --api <url>      the API (default API_BASE_URL from the environment)
//   --only a,b       run only these checks          --list   print the ids and stop
//   --max-ms <n>     the limit for a first request to a public page (default 5000)
//   --json           machine-readable output
//
// It reads ADMIN_TOKEN from the environment for the admin checks and never prints it. It sends nothing to a vendor, posts nothing, opens
// nothing on another repository and creates no data: its only writes to our own services are GET requests, plus a burst of GET /health to
// see the rate limit.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  findLeaks,
  judgeCi,
  judgeColdStart,
  judgeEdgeCache,
  judgeLicense,
  judgeRateLimit,
  judgeUnfurl,
  parseMeta,
  slugsFromSitemap,
  summarise,
} from './launch-check-lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({
  options: {
    site: { type: 'string', default: 'https://quickstartrot.vercel.app' },
    api: { type: 'string', default: process.env.API_BASE_URL ?? '' },
    only: { type: 'string', default: '' },
    list: { type: 'boolean', default: false },
    'max-ms': { type: 'string', default: '5000' },
    json: { type: 'boolean', default: false },
  },
});
const SITE = values.site.replace(/\/+$/, '');
const API = values.api.replace(/\/+$/, '');
const SITE_HOST = new URL(SITE).host;
const MAX_MS = Number(values['max-ms']);
const TOKEN = process.env.ADMIN_TOKEN ?? '';

const sh = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: 'utf8',
    shell: process.platform === 'win32' && cmd === 'pnpm',
    ...opts,
  });
const clip = (s, n = 300) =>
  (s.length > n ? `${s.slice(0, n - 1)}...` : s).replaceAll(/\s+/g, ' ').trim();

/** One timed GET: time to the headers, time to the end of the body, the status and the headers. Never throws. */
async function timed(url, init = {}) {
  const t0 = performance.now();
  try {
    const res = await fetch(url, { redirect: 'manual', ...init });
    const t1 = performance.now();
    const body = Buffer.from(await res.arrayBuffer());
    return {
      url,
      status: res.status,
      ttfbMs: Math.round(t1 - t0),
      totalMs: Math.round(performance.now() - t0),
      headers: res.headers,
      body,
    };
  } catch (err) {
    return {
      url,
      status: 0,
      ttfbMs: 0,
      totalMs: Math.round(performance.now() - t0),
      headers: new Headers(),
      body: Buffer.alloc(0),
      error: String(err.cause?.code ?? err.message),
    };
  }
}
const textOf = (r) => r.body.toString('utf8');

/** An admin GET, retried while the API wakes (it sleeps on a free tier and takes up to a minute). */
async function admin(pathname) {
  if (TOKEN === '' || API === '') return null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const r = await timed(`${API}${pathname}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
      signal: AbortSignal.timeout(70_000),
    });
    if (r.status === 200) return JSON.parse(textOf(r));
    if (![0, 502, 503, 504].includes(r.status)) return null;
  }
  return null;
}
const needAdmin = () => ({
  status: 'SKIP',
  evidence: 'needs ADMIN_TOKEN and API_BASE_URL in the environment (run with --env-file=.env)',
});

let slugs = [];
async function slugList() {
  if (slugs.length === 0) slugs = slugsFromSitemap(textOf(await timed(`${SITE}/sitemap.xml`)));
  return slugs;
}

const PAGES = ['/', '/methodology', '/bot', '/incidents', '/submit', '/robots.txt', '/sitemap.xml'];
const pipeline = async () => {
  try {
    return (await import(path.join(ROOT, 'packages/core/dist/index.js'))).PIPELINE;
  } catch {
    return null;
  }
};

const CHECKS = [
  {
    id: 'site-reachable',
    title: 'The public pages answer',
    async run() {
      const rows = await Promise.all(PAGES.map((p) => timed(`${SITE}${p}`)));
      const bad = rows.filter((r) => r.status !== 200);
      return bad.length === 0
        ? { status: 'PASS', evidence: `${rows.length} pages answer 200` }
        : {
            status: 'FAIL',
            evidence: bad.map((r) => `${r.url} ${r.status || r.error}`).join('; '),
          };
    },
  },
  ...[
    ['unfurl-home', '/'],
    ['unfurl-methodology', '/methodology'],
  ].map(([id, p]) => ({
    id,
    title: `A link to ${p} unfurls with its own 1200 by 630 card`,
    async run() {
      const page = await timed(`${SITE}${p}`);
      if (page.status !== 200) return { status: 'FAIL', evidence: `${p} answers ${page.status}` };
      const meta = parseMeta(textOf(page));
      let image = null;
      if (meta['og:image']) {
        const r = await timed(meta['og:image']);
        image = {
          status: r.status,
          contentType: r.headers.get('content-type'),
          bytes: r.body,
          length: r.body.length,
        };
      }
      const verdict = judgeUnfurl({ siteHost: SITE_HOST, meta, image });
      // a page-specific card: /methodology must not fall back to the home page's image
      if (
        verdict.status === 'PASS' &&
        p !== '/' &&
        !meta['og:image'].endsWith(`/api/og/${p.slice(1)}`)
      )
        return { status: 'FAIL', evidence: `${p} uses ${meta['og:image']}, not its own card` };
      return verdict;
    },
  })),
  {
    id: 'readme-matches-site',
    title: 'The README counts and level wording equal the site',
    async run() {
      const r = sh('node', ['packages/cli/dist/main.js', 'readme', '--check', '--site', SITE]);
      const out = clip(`${r.stdout}${r.stderr}`.replaceAll(/\{"level".*\n?/g, ''));
      return r.status === 0
        ? { status: 'PASS', evidence: out }
        : { status: 'FAIL', evidence: out || `exit ${r.status}` };
    },
  },
  {
    id: 'detection-summary-current',
    title: 'The file /methodology reads equals docs/detection-power.json',
    async run() {
      const r = sh('node', ['packages/cli/dist/main.js', 'detection-summary', '--check']);
      const out = clip(`${r.stdout}${r.stderr}`.replaceAll(/\{"level".*\n?/g, ''));
      return r.status === 0
        ? { status: 'PASS', evidence: out }
        : { status: 'FAIL', evidence: out || `exit ${r.status}` };
    },
  },
  {
    id: 'status-matches-home',
    title: 'GET /api/status gives the numbers the home page headline shows',
    async run() {
      const [api, home] = await Promise.all([timed(`${SITE}/api/status`), timed(`${SITE}/`)]);
      if (api.status !== 200)
        return { status: 'FAIL', evidence: `/api/status answers ${api.status}` };
      const s = JSON.parse(textOf(api));
      const m = /class="tabular text-accent">(\d+) of (\d+)</.exec(textOf(home));
      if (!m) return { status: 'FAIL', evidence: 'the home page has no "X of Y" headline' };
      const same = Number(m[1]) === s.headline.passing && Number(m[2]) === s.headline.tested;
      return {
        status: same ? 'PASS' : 'WARN',
        evidence: `home says ${m[1]} of ${m[2]}; /api/status says ${s.headline.passing} of ${s.headline.tested}${same ? '' : ' (the two caches may differ by a few minutes; run again)'}`,
      };
    },
  },
  {
    id: 'cycle-valid',
    title: 'The latest finished cycle was valid and recent',
    async run() {
      const stats = await admin('/admin/stats?days=2');
      if (stats === null) return needAdmin();
      const cycle = stats.cycles.recent.find((c) => c.valid !== null);
      if (!cycle) return { status: 'FAIL', evidence: 'no finished cycle in the last two days' };
      const p = await pipeline();
      const ageH = (Date.now() - Date.parse(cycle.startedAt)) / 3_600_000;
      const limit = (p?.cycleHours ?? 6) * 2 + 1;
      const base = `cycle ${cycle.id.slice(0, 8)} started ${cycle.startedAt}, ${cycle.tools} tools, ${cycle.harnessErrors} harness errors, ${cycle.trigger}`;
      if (cycle.valid !== true || cycle.canaryOk === false)
        return {
          status: 'FAIL',
          evidence: `${base}; INVALID: ${cycle.problems.join('; ') || 'canaries'}`,
        };
      if (ageH > limit)
        return {
          status: 'FAIL',
          evidence: `${base}; ${ageH.toFixed(1)} h old, the cron may have stalled (limit ${limit} h)`,
        };
      return { status: 'PASS', evidence: `${base}; valid, canaries ok, ${ageH.toFixed(1)} h old` };
    },
  },
  {
    id: 'no-unreviewed-public',
    title: 'No unreviewed incident (cause, summary, fix) appears on any public page',
    async run() {
      const queue = await admin('/admin/queue');
      if (queue === null) return needAdmin();
      const pending = queue.pendingIncidents;
      if (pending.length === 0)
        return {
          status: 'PASS',
          evidence: 'no incident is waiting for review, so nothing unreviewed can be shown',
        };
      const leaks = [];
      for (const i of pending) {
        const needles = [i.signature, i.summary ?? '', i.suggestedFix ?? ''];
        const urls = [
          `/tools/${i.toolSlug}`,
          `/api/og/${i.toolSlug}`,
          `/api/badge/${i.toolSlug}`,
          '/',
          '/incidents',
          '/api/status',
        ];
        const tool = await timed(`${SITE}/tools/${i.toolSlug}`);
        for (const m of textOf(tool).matchAll(/\/runs\/([0-9a-f-]{36})/g))
          urls.push(`/runs/${m[1]}`);
        for (const u of new Set(urls)) {
          const r = await timed(`${SITE}${u}`);
          const found = findLeaks(textOf(r), needles);
          if (found.length > 0)
            leaks.push(`${u} shows text of pending incident ${i.id.slice(0, 8)}`);
          if (u.startsWith('/tools/') || u.startsWith('/runs/'))
            if (textOf(r).includes(i.failureClass)) leaks.push(`${u} names ${i.failureClass}`);
        }
      }
      return leaks.length === 0
        ? {
            status: 'PASS',
            evidence: `${pending.length} pending incident(s); none of their signature, summary, fix or class is on any page that could show it`,
          }
        : { status: 'FAIL', evidence: leaks.join('; ') };
    },
  },
  {
    id: 'disclosures-48h',
    title: 'No vendor heads-up is inside its wait window (the part that can be seen from here)',
    async run() {
      const queue = await admin('/admin/queue');
      if (queue === null) return needAdmin();
      const vendor = queue.pendingIncidents.filter((i) =>
        ['DEPENDENCY_RESOLUTION', 'API_DRIFT', 'DOCS_SNIPPET_ERROR', 'RUNTIME_VERSION'].includes(
          i.failureClass,
        ),
      );
      const p = await pipeline();
      const wait = p?.disclosureWaitHours ?? 48;
      const recent = vendor.filter((i) => Date.now() - Date.parse(i.openedAt) < wait * 3_600_000);
      if (vendor.length === 0)
        return {
          status: 'PASS',
          evidence:
            'no vendor-class incident is waiting for review, so no heads-up can be due; the by-hand log still decides',
        };
      return {
        status: 'MANUAL',
        evidence: `${vendor.length} vendor-class incident(s) wait for review (${recent.length} opened inside ${wait} h): ${vendor.map((i) => `${i.toolSlug} ${i.failureClass}`).join(', ')}. Check the disclosure log: each needs a heads-up sent at least ${wait} h ago, or stays unconfirmed`,
      };
    },
  },
  {
    id: 'ci-green',
    title: 'CI is green for the commit at the head of main',
    async run() {
      const origin = sh('git', ['remote', 'get-url', 'origin']).stdout.trim();
      const repo = /github\.com[/:]([^/]+\/[^/.]+)/.exec(origin)?.[1];
      if (!repo) return { status: 'SKIP', evidence: 'origin is not a GitHub repository' };
      const head = sh('git', ['rev-parse', 'HEAD']).stdout.trim();
      const r = await timed(
        `https://api.github.com/repos/${repo}/actions/workflows/ci.yml/runs?branch=main&per_page=5`,
        { headers: { accept: 'application/vnd.github+json', 'user-agent': 'qsr-launch-check' } },
      );
      if (r.status !== 200) return { status: 'SKIP', evidence: `GitHub answered ${r.status}` };
      return judgeCi(JSON.parse(textOf(r)).workflow_runs, head);
    },
  },
  {
    id: 'secrets-history',
    title: 'The gitleaks job of CI (the whole history) passed for the head',
    async run() {
      const origin = sh('git', ['remote', 'get-url', 'origin']).stdout.trim();
      const repo = /github\.com[/:]([^/]+\/[^/.]+)/.exec(origin)?.[1];
      const head = sh('git', ['rev-parse', 'HEAD']).stdout.trim();
      const hdr = {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'qsr-launch-check' },
      };
      const runs = await timed(
        `https://api.github.com/repos/${repo}/actions/workflows/ci.yml/runs?branch=main&per_page=1`,
        hdr,
      );
      const run = runs.status === 200 ? JSON.parse(textOf(runs)).workflow_runs[0] : undefined;
      if (!run) return { status: 'SKIP', evidence: 'no CI run to read' };
      const jobs = await timed(
        `https://api.github.com/repos/${repo}/actions/runs/${run.id}/jobs`,
        hdr,
      );
      const job = (jobs.status === 200 ? JSON.parse(textOf(jobs)).jobs : []).find((j) =>
        /gitleaks|secret/i.test(j.name),
      );
      if (!job) return { status: 'SKIP', evidence: 'the CI run has no gitleaks job to read' };
      const note =
        run.head_sha === head
          ? ''
          : ` (run is for ${run.head_sha.slice(0, 7)}, head is ${head.slice(0, 7)})`;
      return job.conclusion === 'success'
        ? {
            status: run.head_sha === head ? 'PASS' : 'WARN',
            evidence: `job "${job.name}" succeeded${note}`,
          }
        : {
            status: job.status === 'completed' ? 'FAIL' : 'WARN',
            evidence: `job "${job.name}" is ${job.conclusion ?? job.status}${note}`,
          };
    },
  },
  {
    id: 'secrets-staged',
    title: 'The local secret gate runs and the working tree has nothing staged that it refuses',
    async run() {
      const r = sh('node', ['scripts/secrets-check.mjs']);
      const out = clip(`${r.stdout}${r.stderr}`.replaceAll(/\u001b\[[0-9;]*m/g, ''), 200);
      return r.status === 0
        ? { status: 'PASS', evidence: out }
        : r.status === 2
          ? { status: 'SKIP', evidence: out }
          : { status: 'FAIL', evidence: out };
    },
  },
  {
    id: 'actionlint',
    title: 'actionlint finds nothing in the workflows (the pinned image CI uses)',
    async run() {
      if (sh('docker', ['info']).status !== 0)
        return { status: 'SKIP', evidence: 'Docker is not running here' };
      const ci = readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');
      const image = /rhysd\/actionlint:[^\s'"]+/.exec(ci)?.[0];
      if (!image) return { status: 'SKIP', evidence: 'no pinned actionlint image in ci.yml' };
      const r = sh('docker', [
        'run',
        '--rm',
        '-v',
        `${ROOT}:/repo`,
        '-w',
        '/repo',
        image,
        '-color',
      ]);
      return r.status === 0
        ? { status: 'PASS', evidence: `${image.split('@')[0]}: no findings` }
        : { status: 'FAIL', evidence: clip(`${r.stdout}${r.stderr}`) };
    },
  },
  {
    id: 'license',
    title: 'A LICENSE file exists and the README names it',
    async run() {
      const file = path.join(ROOT, 'LICENSE');
      const readme = readFileSync(path.join(ROOT, 'README.md'), 'utf8');
      return judgeLicense({
        license: existsSync(file) ? readFileSync(file, 'utf8') : null,
        readmeSection: /## License\n([\s\S]*)$/.exec(readme)?.[1] ?? '',
      });
    },
  },
  {
    id: 'cold-start-pages',
    title: `The first request to a public page or badge answers in under ${MAX_MS} ms`,
    async run() {
      const [slug = 'resend-node'] = await slugList();
      const urls = [
        ['site /', '/'],
        ['site /methodology', '/methodology'],
        ['site /bot', '/bot'],
        ['site /incidents', '/incidents'],
        ['site /submit', '/submit'],
        [`site /tools/${slug}`, `/tools/${slug}`],
        [`badge ${slug}`, `/api/badge/${slug}`],
        ['og home', '/api/og/home'],
        ['og methodology', '/api/og/methodology'],
        ['status counts', '/api/status'],
      ];
      const rows = [];
      for (const [name, p] of urls) rows.push({ name, ...(await timed(`${SITE}${p}`)) });
      return judgeColdStart(rows, { maxMs: MAX_MS });
    },
  },
  {
    id: 'cold-start-api',
    title: 'How long the API takes to wake (information: public pages never wait for it)',
    async run() {
      if (API === '') return needAdmin();
      const r = await timed(`${API}/health`, { signal: AbortSignal.timeout(120_000) });
      if (r.status !== 200)
        return {
          status: 'FAIL',
          evidence: `${API}/health answered ${r.status || r.error} after ${r.totalMs} ms`,
        };
      return {
        status: r.totalMs > 5000 ? 'WARN' : 'PASS',
        evidence: `${r.totalMs} ms${r.totalMs > 5000 ? ' (it was asleep). Only /submit, admin and the revalidate hook use it; /submit wakes it when the page opens' : ' (it was awake)'}`,
      };
    },
  },
  {
    id: 'pages-independent-of-api',
    title: 'No public page or component reads the API address',
    async run() {
      const r = sh('pnpm', [
        '--filter',
        '@qsr/web',
        'exec',
        'vitest',
        'run',
        'src/lib/no-api-at-render.test.ts',
      ]);
      const out = clip(`${r.stdout}${r.stderr}`.match(/Tests\s+[^\n]*/)?.[0] ?? '');
      return r.status === 0
        ? { status: 'PASS', evidence: out || 'passed' }
        : { status: 'FAIL', evidence: clip(`${r.stdout}${r.stderr}`) };
    },
  },
  {
    id: 'badges-cached',
    title: 'Badge endpoints are cached by the CDN',
    async run() {
      const [slug = 'resend-node'] = await slugList();
      const responses = [];
      for (let i = 0; i < 3; i += 1) {
        const r = await timed(`${SITE}/api/badge/${slug}`);
        responses.push({
          cacheControl: r.headers.get('cache-control'),
          xVercelCache: r.headers.get('x-vercel-cache'),
          age: r.headers.get('age'),
        });
      }
      return judgeEdgeCache(responses, 600);
    },
  },
  {
    id: 'abuse-unknown-slugs',
    title: 'Unknown slugs on the public image endpoints are answered quickly and safely',
    async run() {
      const rand = () => `zz-${Math.random().toString(36).slice(2, 10)}`;
      const rows = [];
      for (let i = 0; i < 12; i += 1) {
        const s = rand();
        rows.push(await timed(`${SITE}/api/badge/${s}`), await timed(`${SITE}/api/og/${s}`));
      }
      const wrong = rows.filter(
        (r) => !(r.url.includes('/badge/') ? r.status === 200 : r.status === 404),
      );
      const slow = rows.filter((r) => r.totalMs > MAX_MS);
      const odd = rows.filter(
        (r) => r.url.includes('/badge/') && !textOf(r).includes('not tracked'),
      );
      const median = [...rows].sort((a, b) => a.totalMs - b.totalMs)[Math.floor(rows.length / 2)]
        .totalMs;
      if (wrong.length + slow.length + odd.length > 0)
        return {
          status: 'FAIL',
          evidence: `${wrong.length} unexpected statuses, ${slow.length} over ${MAX_MS} ms, ${odd.length} badges without "not tracked"`,
        };
      return {
        status: 'PASS',
        evidence: `${rows.length} requests for slugs that do not exist: badges say "not tracked", images 404, median ${median} ms`,
      };
    },
  },
  {
    id: 'rate-limit-api',
    title: 'The API limits a burst from one address',
    async run() {
      if (API === '') return needAdmin();
      const statuses = [];
      const cap = 400;
      for (let i = 0; i < cap && !statuses.includes(429); i += 20) {
        const batch = await Promise.all(
          Array.from({ length: 20 }, () =>
            timed(`${API}/health`, { signal: AbortSignal.timeout(70_000) }),
          ),
        );
        statuses.push(...batch.map((r) => r.status));
      }
      return judgeRateLimit(statuses, { allowedBeforeLimit: cap });
    },
  },
  {
    id: 'vendor-issues-answered',
    title: 'No vendor question or opt-out issue is waiting for an answer',
    async run() {
      const origin = sh('git', ['remote', 'get-url', 'origin']).stdout.trim();
      const repo = /github\.com[/:]([^/]+\/[^/.]+)/.exec(origin)?.[1];
      const hdr = {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'qsr-launch-check' },
      };
      const open = [];
      for (const label of ['vendor', 'opt-out']) {
        const r = await timed(
          `https://api.github.com/repos/${repo}/issues?state=open&labels=${label}&per_page=30`,
          hdr,
        );
        if (r.status !== 200) return { status: 'SKIP', evidence: `GitHub answered ${r.status}` };
        open.push(...JSON.parse(textOf(r)).filter((i) => !i.pull_request && i.comments === 0));
      }
      return open.length === 0
        ? { status: 'PASS', evidence: 'no open vendor or opt-out issue without a reply' }
        : {
            status: 'FAIL',
            evidence: open.map((i) => `#${i.number} ${clip(i.title, 60)}`).join('; '),
          };
    },
  },
  {
    id: 'disclosure-log',
    title: 'By hand: the disclosure log is complete and no heads-up is inside its wait',
    run: async () => ({
      status: 'MANUAL',
      evidence:
        'read your log of vendor heads-ups: each one sent at least the wait before the post, replies recorded, nothing named without them',
    }),
  },
  {
    id: 'post-claims',
    title: 'By hand: every number in the launch post is on the site today',
    run: async () => ({
      status: 'MANUAL',
      evidence:
        'compare each figure in the post with the home page and /methodology on the day; remove any that is not there',
    }),
  },
];

async function main() {
  if (values.list) {
    for (const c of CHECKS) console.log(c.id);
    return 0;
  }
  const only = new Set(values.only.split(',').filter(Boolean));
  const unknown = [...only].filter((id) => !CHECKS.some((c) => c.id === id));
  if (unknown.length > 0) {
    console.error(`unknown check: ${unknown.join(', ')} (use --list)`);
    return 2;
  }
  const results = [];
  for (const c of CHECKS.filter((x) => only.size === 0 || only.has(x.id))) {
    let r;
    try {
      r = await c.run();
    } catch (err) {
      r = { status: 'FAIL', evidence: `the check crashed: ${clip(String(err?.message ?? err))}` };
    }
    // belt and braces: the admin token must never reach the output
    const evidence = TOKEN === '' ? r.evidence : r.evidence.replaceAll(TOKEN, '[token]');
    results.push({ id: c.id, title: c.title, status: r.status, evidence });
    if (!values.json) console.log(`${r.status.padEnd(6)} ${c.id.padEnd(28)} ${evidence}`);
  }
  const summary = summarise(results);
  if (values.json)
    console.log(
      JSON.stringify({ site: SITE, at: new Date().toISOString(), results, ...summary }, null, 2),
    );
  else
    console.log(
      `\n${Object.entries(summary.counts)
        .map(([k, v]) => `${v} ${k}`)
        .join(', ')}`,
    );
  return summary.exitCode;
}

process.exitCode = await main();
