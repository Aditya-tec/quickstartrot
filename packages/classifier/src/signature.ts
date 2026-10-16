import { createHash } from 'node:crypto';
import { stripAnsi, type FailureClass } from '@qsr/core';

// Spec section 10, "Failure signature":
//   signature = sha256(class + stepKind + normalize(firstErrorLines))
// firstErrorLines are up to 3 lines matching an error pattern in the failing step's output. normalize
// removes what changes between two runs of the SAME failure (absolute paths, :line:col, hex addresses,
// timestamps, durations, temp dir names, ANSI) and lowercases. Package names and identifiers are kept,
// so "createClient is not a function" and "sendEmail is not a function" stay different failures.

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const SOURCE_EXT = '(?:js|mjs|cjs|jsx|ts|tsx|mts|cts|py|json)';

// Applied in this order. The path rules come after the node_modules rule, which keeps the package
// part of a path (the package name is the identifier that matters).
const STEPS: readonly (readonly [RegExp, string])[] = [
  // timestamps: ISO with `:` or `_` separators (npm names its log files with `_`), clock times, epoch ms
  [/\b\d{4}-\d{2}-\d{2}[T _]\d{2}[:_]\d{2}[:_]\d{2}(?:[._,]\d+)?Z?/g, ''],
  [/\b\d{1,2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?\s?[AP]M\b/gi, ''],
  [/\b\d{1,2}:\d{2}:\d{2}(?:[.,]\d+)?\b/g, ''],
  [/\b1\d{12}\b/g, ''],
  // run ids and uuids (a container is named qsr-<uuid>)
  [new RegExp(`\\bqsr-${UUID}\\b`, 'gi'), ''],
  [new RegExp(`\\b${UUID}\\b`, 'gi'), ''],
  // hex addresses
  [/\b0x[0-9a-f]{4,}\b/gi, ''],
  // temp directory names (pip, npm and mktemp pick a random one per run)
  [/\bpip-(?:install|build-env|req-build|unpacked-wheel|wheel|modern-metadata)-[a-z0-9_]+\b/gi, ''],
  [/\bnpm-\d+-[a-f0-9]{8}\b/gi, ''],
  [/\btmp[._-]?(?=[a-z]*\d)[a-z0-9]{6,}\b/gi, ''],
  // durations
  [/\b\d+(?:\.\d+)?\s?(?:ms|seconds?|secs?|minutes?|mins?|hours?|s|m|h)\b/gi, ''],
  // keep the package part of a path inside node_modules ...
  [/(?<![\w:/@.~-])\/(?:[^\s'"()<>]*?\/)?node_modules\//g, 'node_modules/'],
  // ... then drop every other absolute path: unix, windows, home-relative
  [/(?<![\w:/@.~-])\/[^\s'"()<>]+/g, ''],
  [/\b[A-Za-z]:\\[^\s'"()<>]+/g, ''],
  [/(?<![\w])~\/[^\s'"()<>]+/g, ''],
  // :line:col after a source file, TypeScript's (line,col), Python's ", line N"
  [new RegExp(`(?<=\\.${SOURCE_EXT})(?::\\d+){1,2}`, 'g'), ''],
  [new RegExp(`(?<=\\.${SOURCE_EXT})\\(\\d+,\\d+\\)`, 'g'), ''],
  [/,\s*line\s+\d+/gi, ''],
];

export function normalize(text: string): string {
  let out = stripAnsi(text);
  for (const [re, replacement] of STEPS) out = out.replace(re, replacement);
  return out.toLowerCase().replaceAll(/\s+/g, ' ').trim();
}

const ERROR_WORDS =
  /\b(?:error|exception|failed|failure|fatal|denied|not found|cannot|can't|unable|invalid|unauthori[sz]ed|forbidden|refused|reset|timed? ?out|no matching|is not|not defined|no module)\b|ERR!|\bE[A-Z]{3,}\b|\bTS\d{4}\b/i;
const NOISE =
  /^\s+at\s|^\s*File "|^\s*Traceback \(most recent call last\)|A complete log of this run|^\s*\^+\s*$/;

/** Up to `max` lines that look like errors, in order, with stack frames and log pointers skipped. */
export function firstErrorLines(text: string, max = 3): string[] {
  const out: string[] = [];
  for (const raw of stripAnsi(text).split(/\r?\n/)) {
    if (out.length >= max) break;
    if (raw.trim() === '' || NOISE.test(raw)) continue;
    if (ERROR_WORDS.test(raw)) out.push(raw.trim());
  }
  return out;
}

/** sha256 over the class, the step kind and the normalized first (up to 3) error lines. */
export function computeSignature(
  failureClass: FailureClass,
  stepKind: string,
  errorLines: readonly string[],
): string {
  const body = normalize(errorLines.slice(0, 3).join('\n'));
  return createHash('sha256').update(`${failureClass}\u0000${stepKind}\u0000${body}`).digest('hex');
}
