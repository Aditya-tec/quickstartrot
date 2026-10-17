// A stand-in for the Render API, for the end-to-end tests only. It speaks just enough of the real API:
//   POST /submissions                      (the /submit form; behaviour is picked by words in the docs URL)
//   GET  /admin/queue                      (bearer token required)
//   POST /admin/incidents/:id/confirm      (bearer token required)
//   POST /admin/incidents/:id/false-positive
// and two test-only endpoints: GET /__state (what the stub recorded) and POST /__reset.
// Run: node e2e/stub-api.mjs   (port from STUB_API_PORT, token from ADMIN_TOKEN)
import { createServer } from 'node:http';

const PORT = Number(process.env.STUB_API_PORT ?? 4010);
const TOKEN = process.env.ADMIN_TOKEN ?? '';

const PENDING_ID = '00000000-0000-4000-8000-0000000000a1';
const SECOND_ID = '00000000-0000-4000-8000-0000000000a2';
const fresh = () => ({
  submissions: [],
  confirmed: [],
  falsePositives: [],
  wakeAttempts: 0,
  forwardedFor: [],
  pending: [
    {
      id: PENDING_ID,
      toolSlug: 'fastify-node',
      signature: 'sig-pending-1',
      failureClass: 'API_DRIFT',
      review: 'PENDING_REVIEW',
      openedAt: '2026-10-16T12:00:00.000Z',
      summary: 'Draft: the start() helper was renamed in 6.0.',
      suggestedFix: 'Use listen() instead of start().',
      docsChanged: false,
    },
    {
      id: SECOND_ID,
      toolSlug: 'zod-node',
      signature: 'sig-pending-2',
      failureClass: 'DEPENDENCY_RESOLUTION',
      review: 'PENDING_REVIEW',
      openedAt: '2026-10-16T18:00:00.000Z',
      summary: null,
      suggestedFix: null,
      docsChanged: null,
    },
  ],
});
let state = fresh();

const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};
const problem = (res, status, detail, headers) =>
  send(
    res,
    status,
    { type: 'about:blank', title: 'Problem', status, detail },
    { ...headers, 'content-type': 'application/problem+json' },
  );
const authorised = (req) => TOKEN !== '' && req.headers.authorization === `Bearer ${TOKEN}`;
const readJson = (req) =>
  new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw || 'null'));
      } catch {
        resolve(null);
      }
    });
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://stub');
  const path = url.pathname;

  if (req.method === 'GET' && path === '/health') return send(res, 200, { status: 'ok' });
  if (req.method === 'GET' && path === '/__state') return send(res, 200, state);
  if (req.method === 'POST' && path === '/__reset') {
    state = fresh();
    return send(res, 200, { ok: true });
  }

  if (req.method === 'POST' && path === '/submissions') {
    const body = await readJson(req);
    const docsUrl = String(body?.docsUrl ?? '');
    state.forwardedFor.push(req.headers['x-forwarded-for'] ?? null);
    if (docsUrl.includes('rate-limit'))
      return problem(res, 429, 'At most 5 submissions a day; try again later.', {
        'retry-after': '3600',
      });
    if (docsUrl.includes('turnstile')) return problem(res, 403, 'Turnstile verification failed.');
    if (docsUrl.includes('wakeup')) {
      // the first two requests behave like a sleeping server
      state.wakeAttempts += 1;
      if (state.wakeAttempts <= 2) return problem(res, 503, 'starting');
    }
    if (docsUrl.includes('slow')) await sleep(6500);
    state.submissions.push(body);
    return send(res, 201, { id: '00000000-0000-4000-8000-0000000000b1', status: 'NEW' });
  }

  if (path.startsWith('/admin/')) {
    if (!authorised(req)) return problem(res, 401, 'A valid admin token is required.');
    if (req.method === 'GET' && path === '/admin/queue')
      return send(res, 200, {
        pendingIncidents: state.pending,
        items: [
          {
            id: '00000000-0000-4000-8000-0000000000c1',
            reason: 'unclassified',
            toolSlug: 'zod-node',
            runId: null,
            cycleId: null,
            detail: { note: 'a failure no rule matched', excerpt: 'Error: something odd' },
            createdAt: '2026-10-16T13:00:00.000Z',
          },
        ],
        submissions: [
          {
            id: '00000000-0000-4000-8000-0000000000d1',
            docsUrl: 'https://docs.example.com/quickstart',
            contact: 'someone@example.com',
            note: 'Please add our SDK.',
            createdAt: '2026-10-16T14:00:00.000Z',
          },
        ],
      });
    const m = /^\/admin\/incidents\/([0-9a-f-]{36})\/(confirm|false-positive)$/.exec(path);
    if (req.method === 'POST' && m) {
      const [, id, action] = m;
      const body = await readJson(req);
      const index = state.pending.findIndex((p) => p.id === id);
      if (index < 0) return problem(res, 409, 'Incident already reviewed.');
      state.pending.splice(index, 1);
      (action === 'confirm' ? state.confirmed : state.falsePositives).push({ id, ...body });
      return send(res, 200, { ok: true });
    }
  }
  return problem(res, 404, 'Not found');
}).listen(PORT, '127.0.0.1', () => console.log(`stub api on ${PORT}`));
