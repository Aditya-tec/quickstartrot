import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
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
});
