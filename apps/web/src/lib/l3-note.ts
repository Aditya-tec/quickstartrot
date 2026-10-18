// A run whose run step passed but whose level was not raised to L3 says why, in one plain line (harness v3). It is a fact about what the
// snippet did. It never affects a level, a status or a badge, and it is only shown for a run that passed.

const NOTES: Record<string, string> = {
  local: 'Snippet executed locally (no vendor involved)',
  no_evidence:
    'The snippet ran, but its output showed no sign of reaching the vendor, so Level 3 is not claimed',
};

export function l3Note(env: Readonly<Record<string, string>>, outcome: string): string | null {
  if (outcome !== 'PASS') return null;
  const key = env['l3'];
  return key === undefined ? null : (NOTES[key] ?? null);
}
