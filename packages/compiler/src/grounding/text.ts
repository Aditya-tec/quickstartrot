import type { ExtractionBlock, SourceRef } from '@qsr/core';

// Pure text helpers for the grounding validator. No I/O, no LLM. Everything here compares exact
// code points: there is deliberately no Unicode normalization (NFKC would fold look-alikes into
// the ASCII the docs contain, which is exactly the attack to catch).

// Zero-width, bidi-control and non-whitespace control characters. Built from numeric ranges so
// this file never contains the characters themselves.
const SUSPICIOUS_RANGES: readonly (readonly [number, number])[] = [
  [0x00, 0x08],
  [0x0b, 0x0c],
  [0x0e, 0x1f],
  [0x7f, 0x9f],
  [0x200b, 0x200d],
  [0x2060, 0x2060],
  [0xfeff, 0xfeff],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
];
const SUSPICIOUS_RE = new RegExp(
  `[${SUSPICIOUS_RANGES.map(([lo, hi]) => `${String.fromCodePoint(lo)}-${String.fromCodePoint(hi)}`).join('')}]`,
  'u',
);

export function hasSuspiciousCharacters(text: string): boolean {
  return SUSPICIOUS_RE.test(text);
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replaces every placeholder key with its dummy value in ONE pass (longest key first), so a
 * replacement that happens to contain another key is never rescanned.
 */
export function applyPlaceholders(text: string, map: Readonly<Record<string, string>>): string {
  const keys = Object.keys(map)
    .filter((k) => k !== '')
    .sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
  if (keys.length === 0) return text;
  const re = new RegExp(keys.map(escapeRegExp).join('|'), 'g');
  return text.replace(re, (key) => `${map[key]}`);
}

/**
 * Spec section 8, step 3, for commands: trim lines, collapse runs of blanks and blank lines.
 * Whitespace INSIDE quotes is preserved, because `echo "a  b"` and `echo "a b"` differ. A
 * backslash-newline continuation stays, and the indentation after it is dropped.
 */
export function normalizeCommand(text: string): string {
  const src = text.replace(/\r\n?/g, '\n');
  let out = '';
  let quote: string | null = null;
  let lineStart = true;
  let space = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src.charAt(i);
    if (quote !== null) {
      out += ch;
      if (ch === '\\' && quote === '"') out += src.charAt(++i);
      else if (ch === quote) quote = null;
    } else if (ch === '\\' && src.charAt(i + 1) === '\n') {
      i++; // the shell deletes a backslash-newline; blanks around it still separate words
    } else if (ch === ' ' || ch === '\t') {
      space = !lineStart;
    } else if (ch === '\n') {
      space = false;
      lineStart = true;
      if (out !== '' && !out.endsWith('\n')) out += '\n';
    } else {
      if (space) out += ' ';
      space = false;
      lineStart = false;
      if (ch === '\\') {
        out += ch + src.charAt(++i);
      } else {
        out += ch;
        if (ch === '"' || ch === "'") quote = ch;
      }
    }
  }
  return out.replace(/\n+$/, '');
}

export interface Boundaries {
  starts: ReadonlySet<number>;
  ends: ReadonlySet<number>;
}

/**
 * Positions in a normalized command where a sub-command may begin or end: the ends of the text,
 * newlines and the separators `&&`, `||` and `;`, but only OUTSIDE quotes. A command is only
 * grounded as a fragment of a cited line when it starts and ends on such a boundary, so
 * `npm install acme-s` can never be passed off as part of `npm install acme-sdk`.
 */
export function commandBoundaries(norm: string): Boundaries {
  const starts = new Set<number>([0]);
  const ends = new Set<number>([norm.length]);
  const mark = (at: number, length: number): void => {
    let end = at;
    while (end > 0 && norm.charAt(end - 1) === ' ') end--;
    ends.add(end);
    let start = at + length;
    while (norm.charAt(start) === ' ') start++;
    starts.add(start);
  };
  let quote: string | null = null;
  for (let i = 0; i < norm.length; i++) {
    const ch = norm.charAt(i);
    const pair = norm.slice(i, i + 2);
    if (quote !== null) {
      if (ch === '\\' && quote === '"') i++;
      else if (ch === quote) quote = null;
    } else if (ch === '\\') {
      i++; // escaped character, including a line continuation
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '\n' || ch === ';') {
      mark(i, 1);
    } else if (pair === '&&' || pair === '||') {
      mark(i, 2);
      i++;
    }
  }
  return { starts, ends };
}

/** True if `cmd` equals the cited text or a whole sub-command of it (both already normalized). */
export function commandMatches(cmd: string, cited: string): boolean {
  if (cmd === '') return false;
  const { starts, ends } = commandBoundaries(cited);
  for (let at = cited.indexOf(cmd); at !== -1; at = cited.indexOf(cmd, at + 1)) {
    if (starts.has(at) && ends.has(at + cmd.length)) return true;
  }
  return false;
}

/**
 * Normalization for file content: CRLF to LF, trailing whitespace per line, blank-line runs and
 * leading/trailing blank lines. Indentation is preserved, which is stricter than the spec's
 * "trim lines" because indentation is program text in Python and YAML.
 */
export function normalizeFileContent(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+|\n+$/g, '');
}

/**
 * Where two different texts first diverge, phrased for the model that has to fix it. Shown in a
 * violation so the single retry can repair e.g. a dropped trailing comma instead of repeating it.
 */
export function describeFirstDifference(docs: string, written: string): string {
  const d = docs.split('\n');
  const w = written.split('\n');
  const at = Array.from({ length: Math.max(d.length, w.length) }, (_, i) => i).find(
    (i) => d[i] !== w[i],
  ) as number; // callers only ask when the texts differ
  const show = (line: string | undefined, ends: string): string =>
    line === undefined ? `nothing (${ends})` : JSON.stringify(line);
  return `first difference at line ${at + 1}: docs have ${show(d[at], 'the cited lines end')}, yours has ${show(w[at], 'the content ends')}`;
}

/** Lines `lineStart..lineEnd` (1-based, inclusive) of a block, or null if the range does not exist. */
export function citedText(block: ExtractionBlock, ref: SourceRef): string | null {
  const lines = block.text.split('\n');
  if (ref.lineStart < 1 || ref.lineEnd < ref.lineStart || ref.lineEnd > lines.length) return null;
  return lines.slice(ref.lineStart - 1, ref.lineEnd).join('\n');
}

/** Whole-token mention of a file path in free text ("create index.ts and ...", "Save it as a/b.ts."). */
export function mentionsPath(text: string, filePath: string): boolean {
  const re = new RegExp(`(^|[^\\w./-])${escapeRegExp(filePath)}(?![\\w/-])(?!\\.\\w)`);
  return re.test(text);
}

/** Whole-token mention of an environment variable name. */
export function mentionsName(text: string, name: string): boolean {
  return new RegExp(`(^|[^A-Za-z0-9_])${escapeRegExp(name)}($|[^A-Za-z0-9_])`).test(text);
}
