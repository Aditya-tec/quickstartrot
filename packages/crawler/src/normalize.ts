import { createHash } from 'node:crypto';
import type { ExtractionBlock } from '@qsr/core';

/** A block as read from the page, before normalization and indexing. */
export interface RawBlock {
  kind: ExtractionBlock['kind'];
  lang: string | null;
  text: string;
  filenameHint: string | null;
  headingPath: string[];
}

const SHELL_LANGS = new Set([
  'sh',
  'bash',
  'shell',
  'zsh',
  'console',
  'terminal',
  'shellscript',
  'shell-session',
  'cmd',
  'powershell',
  'ps1',
]);

export function isShellLang(lang: string | null): boolean {
  return lang !== null && SHELL_LANGS.has(lang.toLowerCase());
}

const PROMPT_RE = /^[ \t]*[$>][ \t]+/;
const DOLLAR_PROMPT_RE = /^[ \t]*\$[ \t]+/;

/**
 * Spec section 7, step 9: trim trailing whitespace per line, CRLF to LF, strip shell prompts
 * (`$ ` or `> ` at line start in shell blocks), collapse 3+ blank lines.
 * Beyond the spec: docs often tag a terminal session as `text`, `pytest` or nothing at all, with
 * `$ command` followed by its output. A block whose first non-empty line starts with `$ ` is
 * treated as a shell session whatever its tag, but then only `$ ` prompts are stripped, so
 * output lines (which may start with `>`) are left alone.
 */
export function normalizeCode(text: string, lang: string | null): string {
  let lines = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, ''));

  if (isShellLang(lang)) {
    lines = lines.map((l) => l.replace(PROMPT_RE, ''));
  } else if (/^[ \t]*\$[ \t]+\S/.test(lines.find((l) => l.trim() !== '') ?? '')) {
    lines = lines.map((l) => l.replace(DOLLAR_PROMPT_RE, ''));
  }

  return lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+|\n+$/g, '');
}

/** Prose and headings: collapse all whitespace runs; drop permalink glyphs and zero-width spaces. */
export function normalizeInline(text: string): string {
  return text
    .replace(/[\u200b\u200c\u200d\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*[#¶§]$/, '')
    .trim();
}

export function normalizeBlocks(
  raw: readonly RawBlock[],
  ignorePatterns: readonly string[],
): ExtractionBlock[] {
  const ignore = ignorePatterns.map((p) => new RegExp(p));
  const out: ExtractionBlock[] = [];
  for (const b of raw) {
    const text = b.kind === 'code' ? normalizeCode(b.text, b.lang) : normalizeInline(b.text);
    if (text === '') continue;
    if (b.kind !== 'heading' && ignore.some((re) => re.test(text))) continue;
    out.push({
      index: out.length,
      kind: b.kind,
      lang: b.lang,
      text,
      filenameHint: b.filenameHint,
      headingPath: b.headingPath.map(normalizeInline).filter((h) => h !== ''),
    });
  }
  return out;
}

/**
 * sha256(JSON.stringify(blocks.map(b => [b.kind, b.lang, b.text]))). Prose wording changes
 * change the hash on purpose: compiles are cached and cheap.
 */
export function contentHash(blocks: readonly ExtractionBlock[]): string {
  const payload = JSON.stringify(blocks.map((b) => [b.kind, b.lang, b.text]));
  return createHash('sha256').update(payload).digest('hex');
}
