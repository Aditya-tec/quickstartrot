import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compileConfigHash, hashJson, type Target } from '@qsr/core';
import { parseTargetFile } from './targets.js';

// The plan cache key of a target includes compileConfigHash(target). Adding `grounding` and `probation` to the target schema (2026-10-19)
// must not move the key of any target that sets neither: that would make every cached plan miss, and the model would be asked again for
// every page (about a day of the free quota). A target that opted in to `grounding.installFromComment` is meant to differ.

const dir = fileURLToPath(new URL('../../../targets', import.meta.url));
const files = readdirSync(dir).filter((f) => f.endsWith('.yaml'));

/** The formula before the two fields existed. */
const before = (t: Target): string =>
  hashJson({
    placeholders: t.placeholders,
    level: t.level,
    language: t.language,
    variants: t.extract.variants ?? null,
  });

describe('every committed target keeps its plan cache key', () => {
  it('reads the target files', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  for (const file of files) {
    it(`${file}`, async () => {
      const target = await parseTargetFile(path.join(dir, file));
      if (target.grounding !== undefined) {
        // opted in: another key, on purpose
        expect(compileConfigHash(target)).not.toBe(before(target));
      } else {
        expect(compileConfigHash(target)).toBe(before(target));
      }
    });
  }
});
