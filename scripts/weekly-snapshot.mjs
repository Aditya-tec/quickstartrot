// Weekly snapshot of the public views (spec section 12, "Gotchas"). Reads public_tools and public_incidents
// with the PUBLIC anon key (the same access any visitor has) and writes data/weekly-status.json. No service
// credentials are involved, and a canary can never appear: the views exclude them and this file drops
// any `canary-*` slug as well.
//
//   SUPABASE_URL=... SUPABASE_ANON_KEY=... node scripts/weekly-snapshot.mjs --out data/weekly-status.json

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export class SnapshotError extends Error {
  name = 'SnapshotError';
}

const INCIDENT_FIELDS = [
  'id',
  'tool_slug',
  'tool_name',
  'failure_class',
  'state',
  'docs_changed',
  'summary',
  'suggested_fix',
  'opened_at',
  'confirmed_at',
  'resolved_at',
];

const isCanary = (slug) => typeof slug === 'string' && slug.startsWith('canary-');
const sortKeys = (obj) =>
  Object.fromEntries(Object.entries(obj).sort(([a], [b]) => (a < b ? -1 : 1)));

/** Pure: rows from the two views in, the committed document out. The same input always gives the same bytes. */
export function buildSnapshot({ tools, incidents }, now) {
  const publicTools = tools
    .filter((t) => !isCanary(t.slug))
    .map(sortKeys)
    .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  const counts = {};
  for (const t of publicTools) counts[t.status] = (counts[t.status] ?? 0) + 1;

  const publicIncidents = incidents
    .filter((i) => !isCanary(i.tool_slug))
    .map((i) => Object.fromEntries(INCIDENT_FIELDS.filter((f) => f in i).map((f) => [f, i[f]])))
    .sort((a, b) => (a.opened_at < b.opened_at ? 1 : a.opened_at > b.opened_at ? -1 : 0));

  return {
    generatedAt: now.toISOString(),
    total: publicTools.length,
    counts: sortKeys(counts),
    tools: publicTools,
    incidents: publicIncidents,
  };
}

export async function fetchSnapshot({ url, anonKey, fetch: doFetch = fetch, now = new Date() }) {
  const base = url.replace(/\/+$/, '');
  const headers = { apikey: anonKey, Authorization: `Bearer ${anonKey}` };
  async function read(view, query) {
    let res;
    try {
      res = await doFetch(`${base}/rest/v1/${view}?${query}`, { headers });
    } catch (err) {
      throw new SnapshotError(`${view}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!res.ok) throw new SnapshotError(`${view}: the read was refused with HTTP ${res.status}`);
    return res.json();
  }
  const tools = await read('public_tools', 'select=*&order=slug');
  const incidents = await read('public_incidents', 'select=*&order=opened_at.desc');
  return buildSnapshot({ tools, incidents }, now);
}

async function main() {
  const out = process.argv.includes('--out')
    ? process.argv[process.argv.indexOf('--out') + 1]
    : 'data/weekly-status.json';
  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    console.error(
      'SUPABASE_URL and SUPABASE_ANON_KEY must be set (repository variables; both are public values)',
    );
    process.exit(2);
  }
  const snapshot = await fetchSnapshot({ url, anonKey });
  await mkdir(path.dirname(path.resolve(out)), { recursive: true });
  await writeFile(out, `${JSON.stringify(snapshot, null, 2)}\n`);
  console.log(`wrote ${out}: ${snapshot.total} tools, ${snapshot.incidents.length} incidents`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
