import { outsideWork } from './paths.js';

// Destructive-command denylist (spec section 8, rule 7): enforced even when the command appears
// verbatim in the docs. The analysis is quote-aware and looks inside `bash -c`, `eval` and command
// substitutions. It is a first layer: the sandbox (non-root, --cap-drop ALL, no secrets) is the
// second. When in doubt it denies; a denied step becomes a manual step, never a failure of the vendor.

export interface Segment {
  words: string[];
  redirects: string[];
  subshells: string[];
}

const MAX_DEPTH = 4;

/** Reads `$( ... )` starting at `i` (the `$`). Returns the inner command and the index after `)`. */
function readParen(src: string, i: number): [string, number] {
  let depth = 0;
  for (let j = i + 1; j < src.length; j++) {
    const ch = src.charAt(j);
    if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return [src.slice(i + 2, j), j + 1];
  }
  return [src.slice(i + 2), src.length];
}

/** Reads a backtick substitution starting at `i`. Returns the inner command and the next index. */
function readTicks(src: string, i: number): [string, number] {
  const end = src.indexOf('`', i + 1);
  return end === -1 ? [src.slice(i + 1), src.length] : [src.slice(i + 1, end), end + 1];
}

/** Splits a command line into segments of words, redirect targets and nested substitutions. */
export function parseShell(src: string): Segment[] {
  const segments: Segment[] = [];
  let seg: Segment = { words: [], redirects: [], subshells: [] };
  let word = '';
  let hasWord = false;
  let toRedirect = false;

  const pushWord = (): void => {
    if (!hasWord) return;
    (toRedirect ? seg.redirects : seg.words).push(word);
    toRedirect = false;
    word = '';
    hasWord = false;
  };
  const endSegment = (): void => {
    pushWord();
    toRedirect = false;
    if (seg.words.length + seg.redirects.length + seg.subshells.length > 0) segments.push(seg);
    seg = { words: [], redirects: [], subshells: [] };
  };
  const substitution = (i: number): number => {
    const [inner, next] = src.charAt(i) === '`' ? readTicks(src, i) : readParen(src, i);
    seg.subshells.push(inner);
    hasWord = true;
    return next;
  };

  let i = 0;
  while (i < src.length) {
    const ch = src.charAt(i);
    const next = src.charAt(i + 1);
    if (ch === "'") {
      const end = src.indexOf("'", i + 1);
      const stop = end === -1 ? src.length : end;
      word += src.slice(i + 1, stop);
      hasWord = true;
      i = stop + 1;
    } else if (ch === '"') {
      hasWord = true;
      i++;
      while (i < src.length && src.charAt(i) !== '"') {
        const inner = src.charAt(i);
        if (inner === '\\') {
          word += src.charAt(i + 1);
          i += 2;
        } else if (inner === '`' || (inner === '$' && src.charAt(i + 1) === '(')) {
          i = substitution(i);
        } else {
          word += inner;
          i++;
        }
      }
      i++;
    } else if (ch === '`' || (ch === '$' && next === '(')) {
      i = substitution(i);
    } else if (ch === '\\') {
      if (next !== '\n') {
        word += next;
        hasWord = true;
      }
      i += 2;
    } else if (ch === ' ' || ch === '\t') {
      pushWord();
      i++;
    } else if (ch === '>' || (ch === '&' && next === '>')) {
      // Redirect: drop a leading file-descriptor number, skip the operator, take the next word.
      if (/^\d+$/.test(word)) {
        word = '';
        hasWord = false;
      }
      pushWord();
      i += ch === '&' ? 2 : 1;
      while (src.charAt(i) === '>' || src.charAt(i) === '|' || src.charAt(i) === '&') i++;
      toRedirect = true;
    } else if (ch === '\n' || ch === ';' || ch === '|' || ch === '&') {
      endSegment();
      i += (ch === '|' || ch === '&') && next === ch ? 2 : 1;
    } else {
      word += ch;
      hasWord = true;
      i++;
    }
  }
  endSegment();
  return segments;
}

const WRAPPERS = new Set(['env', 'command', 'exec', 'nohup', 'time', 'nice', 'xargs']);
const SHUTDOWN = new Set(['shutdown', 'reboot', 'halt', 'poweroff']);
const WRITERS = new Set([
  'rm',
  'rmdir',
  'mv',
  'cp',
  'ln',
  'install',
  'touch',
  'mkdir',
  'tee',
  'truncate',
  'chmod',
  'chown',
  'chgrp',
  'rsync',
]);
const OUTPUT_FLAGS = new Set([
  '-o',
  '--output',
  '--output-dir',
  '-O',
  '--output-document',
  '-P',
  '--directory-prefix',
]);

function isForkBomb(command: string): boolean {
  for (const m of command.matchAll(/([^\s(){};&|]+)\s*\(\s*\)\s*\{([^}]*)\}/g)) {
    const [, name, body] = m as unknown as [string, string, string]; // both groups always participate
    if (body.split(name).length - 1 >= 2 && body.includes('|') && body.includes('&')) return true;
  }
  return false;
}

const ASSIGNMENT = /^[A-Za-z_]\w*=/;
const isFlag = (word: string | undefined): boolean => word?.startsWith('-') === true;

function checkSegment(seg: Segment, depth: number): string | null {
  if (seg.words.some((w) => w === 'sudo' || w === 'doas'))
    return 'privilege escalation (sudo/doas)';

  const words = [...seg.words];
  // Skip leading VAR=value assignments and transparent wrappers (env, nohup, ...) with their flags.
  for (let w = words[0]; w !== undefined && (ASSIGNMENT.test(w) || WRAPPERS.has(w)); w = words[0]) {
    words.shift();
    if (WRAPPERS.has(w)) while (isFlag(words[0])) words.shift();
  }

  const [command = '', ...args] = words;
  const name = command.slice(command.lastIndexOf('/') + 1); // /usr/bin/sudo -> sudo

  if (name === 'mkfs' || name.startsWith('mkfs.')) return 'filesystem creation (mkfs)';
  if (SHUTDOWN.has(name)) return `system shutdown (${name})`;

  if (/^(ba|z|da)?sh$/.test(name)) {
    const at = args.findIndex((a) => /^-[a-z]*c[a-z]*$/.test(a));
    if (at !== -1) return findDestructive(args[at + 1] ?? '', depth + 1);
  }
  if (name === 'eval') return findDestructive(args.join(' '), depth + 1);

  if (WRITERS.has(name)) {
    const target = args.find((a) => !isFlag(a) && outsideWork(a));
    if (target !== undefined) return `${name} touches ${target}, outside /work`;
  }
  if (name === 'dd') {
    const target = args.find((a) => a.startsWith('of=') && outsideWork(a.slice(3)));
    if (target !== undefined) return `dd writes to ${target.slice(3)}, outside /work`;
  }
  if (name === 'curl' || name === 'wget') {
    const at = args.findIndex((a, k) => OUTPUT_FLAGS.has(a) && outsideWork(args[k + 1] ?? ''));
    if (at !== -1) return `${name} writes to ${args[at + 1]}, outside /work`;
  }

  const redirect = seg.redirects.find(outsideWork);
  if (redirect !== undefined) return `redirects output to ${redirect}, outside /work`;
  return null;
}

/** Returns why a command is destructive, or null if it is acceptable. */
export function findDestructive(command: string, depth = 0): string | null {
  if (depth > MAX_DEPTH) return 'command nesting is too deep to analyse';
  if (isForkBomb(command)) return 'fork bomb';
  for (const seg of parseShell(command)) {
    for (const inner of seg.subshells) {
      const reason = findDestructive(inner, depth + 1);
      if (reason !== null) return reason;
    }
    const reason = checkSegment(seg, depth);
    if (reason !== null) return reason;
  }
  return null;
}
