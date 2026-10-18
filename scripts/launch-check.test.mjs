import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

// The driver's pacing, against a local fake API (nothing leaves this machine). The launch check once knocked over the production API with a
// 20-wide burst of GET /health; this keeps it to one request at a time, bounded by the limit the limiter advertises, and refuses to burst
// against a /health that still pings the database.

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'launch-check.mjs');
const servers = [];
after(() => servers.forEach((s) => s.close()));

/** A fake API: GET /health with the limiter headers; 429 once `limit` requests have been counted. */
async function fakeApi({ limit, deep = false }) {
  const stats = { requests: 0, maxAtOnce: 0, atOnce: 0, times: [], last429: false };
  const server = createServer((req, res) => {
    stats.requests += 1;
    stats.times.push(Date.now());
    stats.atOnce += 1;
    stats.maxAtOnce = Math.max(stats.maxAtOnce, stats.atOnce);
    const remaining = Math.max(0, limit - stats.requests);
    const headers = {
      'content-type': 'application/json',
      'x-ratelimit-limit': String(limit),
      'x-ratelimit-remaining': String(remaining),
      'x-ratelimit-reset': '55',
    };
    // answer a little later, so overlapping requests would be seen
    setTimeout(() => {
      stats.atOnce -= 1;
      if (stats.requests > limit) {
        stats.last429 = true;
        res.writeHead(429, { ...headers, 'retry-after': '55' });
        res.end('{"title":"Too Many Requests"}');
        return;
      }
      res.writeHead(200, headers);
      res.end(
        JSON.stringify(deep ? { status: 'ok', db: true, time: 'x' } : { status: 'ok', time: 'x' }),
      );
    }, 20);
  });
  servers.push(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, stats };
}

function run(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, '--json', '--pause-ms', '0', ...args], {
      env: { ...process.env, ADMIN_TOKEN: '', API_BASE_URL: '' },
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('close', (code) => resolve({ code, json: JSON.parse(out) }));
  });
}

test('--no-burst reads the limiter from its headers with three requests and never bursts', async () => {
  const api = await fakeApi({ limit: 6 });
  const { json } = await run(['--only', 'rate-limit-api', '--api', api.url, '--no-burst']);
  const r = json.results[0];
  assert.equal(r.status, 'PASS');
  assert.match(r.evidence, /skipped \(--no-burst\)/);
  assert.equal(api.stats.requests, 3);
});

test('the burst is one request at a time, stops at the first 429, and never exceeds the limit plus five', async () => {
  const api = await fakeApi({ limit: 6 });
  const { json } = await run(['--only', 'rate-limit-api', '--api', api.url]);
  const r = json.results[0];
  assert.equal(r.status, 'PASS', r.evidence);
  assert.match(r.evidence, /limited at request/);
  assert.equal(api.stats.maxAtOnce, 1, 'two requests were in flight at once');
  assert.ok(api.stats.last429);
  assert.ok(api.stats.requests <= 3 + 6 + 5, `${api.stats.requests} requests`);
  // paced: no two burst requests closer than the interval (a little slack for timers)
  const burst = api.stats.times.slice(3);
  for (let i = 1; i < burst.length; i += 1)
    assert.ok(burst[i] - burst[i - 1] >= 100, `gap ${burst[i] - burst[i - 1]} ms`);
});

test('it refuses to burst against a /health that still pings the database', async () => {
  const api = await fakeApi({ limit: 6, deep: true });
  const { json } = await run(['--only', 'rate-limit-api', '--api', api.url]);
  const r = json.results[0];
  assert.equal(r.status, 'SKIP');
  assert.match(r.evidence, /still pings the database/);
  assert.equal(api.stats.requests, 3, 'only the three header requests were sent');
});

test('a limiter that advertises nothing is a FAIL, and nothing is hammered', async () => {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"status":"ok","time":"x"}');
  });
  servers.push(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { code, json } = await run([
    '--only',
    'rate-limit-api',
    '--api',
    `http://127.0.0.1:${server.address().port}`,
  ]);
  assert.equal(json.results[0].status, 'FAIL');
  assert.equal(code, 1);
});

test('the rate-limit check is the last automated one, after every check that talks to the API or the site', async () => {
  const { stdout } = await new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, '--list']);
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('close', () => resolve({ stdout: out }));
  });
  const ids = stdout.split('\n').filter(Boolean);
  const at = ids.indexOf('rate-limit-api');
  assert.ok(at > ids.indexOf('abuse-unknown-slugs'));
  assert.ok(at > ids.indexOf('cycle-valid'));
  assert.deepEqual(
    ids.slice(at + 1),
    ['disclosure-log', 'post-claims'],
    'only the by-hand items come after it',
  );
});
