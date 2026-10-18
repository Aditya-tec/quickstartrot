import { describe, expect, it } from 'vitest';
import { l3Note } from './l3-note';
import { splitRunnerEnv } from './run-env';

// Harness v3: a run step that passed without evidence of reaching a vendor is not an L3 claim. The run page says so in one plain line. It
// is a statement of fact about what the snippet did, shown only for a run that passed; it changes no level, status or badge.

describe('l3Note', () => {
  it('a local-only snippet that passed says it was executed locally and that no vendor was involved', () => {
    expect(l3Note({ l3: 'local' }, 'PASS')).toBe('Snippet executed locally (no vendor involved)');
  });

  it('a vendor snippet that passed with no sign of the vendor in its output says Level 3 is not claimed', () => {
    expect(l3Note({ l3: 'no_evidence' }, 'PASS')).toBe(
      'The snippet ran, but its output showed no sign of reaching the vendor, so Level 3 is not claimed',
    );
  });

  it('shows nothing when the run did not pass, when there is no note, or when the note is unknown', () => {
    expect(l3Note({ l3: 'local' }, 'FAIL')).toBeNull();
    expect(l3Note({ l3: 'local' }, 'SKIPPED')).toBeNull();
    expect(l3Note({}, 'PASS')).toBeNull();
    expect(l3Note({ l3: 'something else' }, 'PASS')).toBeNull();
  });

  it('the note key is not listed again in the environment table', () => {
    const { other } = splitRunnerEnv({ node: 'v22', l3: 'local', plan_stale: 'true' });
    expect(other.map(([k]) => k)).toEqual(['node']);
  });
});
