import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TRAFFIC } from '@qsr/core';
import { loadAllTargets } from './targets.js';

const TARGETS_DIR = fileURLToPath(new URL('../../../targets', import.meta.url));

// Guards every file committed under targets/: schema-valid, slug equals file name, unique slugs.
describe('committed targets', () => {
  it('all validate against the Target schema', async () => {
    const targets = await loadAllTargets(TARGETS_DIR, { canaries: true });
    expect(targets.length).toBeGreaterThanOrEqual(10);
    const slugs = targets.map((t) => t.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('use https docs URLs and a pinned-by-GHCR image reference', async () => {
    for (const t of await loadAllTargets(TARGETS_DIR)) {
      expect(t.docsUrl.startsWith('https://'), t.slug).toBe(true);
      expect(t.runtime.image.startsWith('ghcr.io/'), t.slug).toBe(true);
    }
  });

  // The site says which services get a request with an invalid credential. That list must be the real one: every enabled target whose
  // run step reaches a vendor (level 3 or shadow-L3, auth-error-as-pass, not declared local), no more and no fewer.
  it('the services the site names (TRAFFIC) are exactly the targets that send a request to a vendor', async () => {
    const real = (await loadAllTargets(TARGETS_DIR))
      .filter(
        (t) =>
          t.enabled !== false &&
          t.level >= 3 &&
          t.expect.authErrorIsPass &&
          t.expect.localOnly !== true,
      )
      .map((t) => t.slug)
      .sort();
    expect(TRAFFIC.services.flatMap((s) => s.targets).sort()).toEqual(real);
  });

  // Go-live after P9a: hashIgnore changes how a page is hashed, so it exists only where a page was shown to print a
  // value that rotates by itself. Every other target hashes exactly as before (packages/core content-hash.test.ts).
  it('only the two Ably pages (a rotating demo key) use extract.hashIgnore', async () => {
    const withRules = (await loadAllTargets(TARGETS_DIR, { canaries: true }))
      .filter((t) => t.extract.hashIgnore !== undefined)
      .map((t) => t.slug)
      .sort();
    expect(withRules).toEqual(['ably-node', 'ably-python']);
  });
});
