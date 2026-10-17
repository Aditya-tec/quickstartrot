import { builtinModules } from 'node:module';
import type { Extraction, ExtractionBlock, FailureClass, Step, StepIR } from '@qsr/core';
import type { Rng } from './rng.js';

// The deterministic mutation operators of `qsr mutate`. A mutant is a pair (extraction, plan) to which the SAME textual
// change was applied: the docs lines and the plan step that quotes them. The caller then asks the real grounding
// validator whether the plan is still the docs' own code; a pair it refuses is discarded as `invalid`. Nothing here
// reads the network, a model or the clock.

export interface Pair {
  extraction: Extraction;
  ir: StepIR;
}

export const OPERATOR_IDS = [
  'pkg_typo',
  'version_pin',
  'renamed_symbol',
  'renamed_method',
  'deep_import',
  'syntax_error',
  'option_misnamed',
  'previous_major',
] as const;
export type OperatorId = (typeof OPERATOR_IDS)[number];

export interface OperatorInfo {
  id: OperatorId;
  title: string;
  /** `experiment` is not an oracle: it is reported apart and labelled. */
  group: 'mutation' | 'experiment';
  /** The classes our documented mapping predicts for a detected mutant, or null when there is no fixed expectation. */
  expected: readonly FailureClass[] | null;
  /** One line for the public document. */
  description: string;
}

export const OPERATOR_INFO: Record<OperatorId, OperatorInfo> = {
  pkg_typo: {
    id: 'pkg_typo',
    title: 'Package name typo in the install command',
    group: 'mutation',
    expected: ['DEPENDENCY_RESOLUTION'],
    description:
      'Two letters are inserted into the name of the first package the docs install (a name that does not exist).',
  },
  version_pin: {
    id: 'version_pin',
    title: 'Non-existent version pin in the install command',
    group: 'mutation',
    expected: ['DEPENDENCY_RESOLUTION'],
    description: 'The first package the docs install is pinned to version 999.999.999.',
  },
  renamed_symbol: {
    id: 'renamed_symbol',
    title: 'Renamed imported symbol',
    group: 'mutation',
    expected: ['API_DRIFT'],
    description:
      'A named import (or destructured require, or from-import) is renamed everywhere in the snippet, so the package no longer has the name.',
  },
  renamed_method: {
    id: 'renamed_method',
    title: 'Renamed method call on the client',
    group: 'mutation',
    expected: ['API_DRIFT'],
    description:
      'A method called on an object the snippet created is renamed to one the SDK does not have.',
  },
  deep_import: {
    id: 'deep_import',
    title: 'Wrong deep import path',
    group: 'mutation',
    expected: ['API_DRIFT'],
    description:
      'The module specifier of an import of the installed package gets a sub-path that does not exist.',
  },
  syntax_error: {
    id: 'syntax_error',
    title: 'Syntax error',
    group: 'mutation',
    expected: ['DOCS_SNIPPET_ERROR'],
    description: 'A closing bracket (or a closing quote) is removed from one line of the snippet.',
  },
  option_misnamed: {
    id: 'option_misnamed',
    title: 'Misnamed option or argument',
    group: 'mutation',
    expected: null,
    description:
      'The name of an option (an object key or a keyword argument) inside a call is changed. No fixed expectation: what happens is recorded.',
  },
  previous_major: {
    id: 'previous_major',
    title: 'Docs ahead of the package (previous major version installed)',
    group: 'experiment',
    expected: null,
    description:
      'EXPERIMENT, not an oracle. The previous major version of the package is installed while the snippet stays as the docs show it today.',
  },
};

export interface Mutant {
  operator: OperatorId;
  /** What was changed, for the report: `ajv -> aqqjv`. */
  change: string;
  pair: Pair;
}

// ---------------------------------------------------------------- text plumbing

const BUILTINS = new Set(builtinModules.flatMap((m) => [m, m.replace(/^node:/, '')]));
const PY_STDLIB = new Set(
  (
    'abc argparse array ast asyncio base64 bisect builtins collections concurrent contextlib copy csv dataclasses datetime decimal ' +
    'enum functools getpass glob gzip hashlib heapq hmac html http importlib inspect io itertools json logging math multiprocessing ' +
    'operator os pathlib pickle platform pprint queue random re secrets shutil signal socket sqlite3 ssl statistics string struct ' +
    'subprocess sys tempfile textwrap threading time traceback types typing unittest urllib uuid warnings weakref zlib __future__'
  ).split(' '),
);

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * Whether two lines are the same docs line. The plan quotes the docs with the target's dummy values already in place of the
 * docs' placeholders (YOUR_API_KEY becomes the dummy key), so lines are compared with those values blanked out.
 */
type Same = (a: string, b: string) => boolean;
function sameLine(placeholders: Readonly<Record<string, string>>): Same {
  const tokens = [...Object.keys(placeholders), ...Object.values(placeholders)]
    .filter((t) => t !== '')
    .sort((a, b) => b.length - a.length);
  if (tokens.length === 0) return (a, b) => a === b;
  const re = new RegExp(tokens.map(esc).join('|'), 'g');
  const blank = String.fromCharCode(1);
  const key = (l: string): string => l.replace(re, blank);
  return (a, b) => key(a) === key(b);
}
const isCommentLine = (line: string): boolean => /^\s*(?:\/\/|#|\*|\/\*|<!--)/.test(line);
const lines = (text: string): string[] => text.split('\n');

type LineFn = (line: string) => string;
const mapText = (text: string, fn: LineFn): string => lines(text).map(fn).join('\n');

interface Scope {
  blockIndex: number;
  /** 1-based inclusive line range of the block, or the whole block. */
  range?: { from: number; to: number };
  stepIds: readonly string[];
}

/** The same per-line change on the cited block lines and on the text of every named step. Null if nothing changed. */
function applyEdit(pair: Pair, scope: Scope, fn: LineFn): Pair | null {
  let changed = false;
  const blocks = pair.extraction.blocks.map((b): ExtractionBlock => {
    if (b.index !== scope.blockIndex) return b;
    const text = lines(b.text)
      .map((l, i) => {
        const n = i + 1;
        if (scope.range && (n < scope.range.from || n > scope.range.to)) return l;
        const out = fn(l);
        if (out !== l) changed = true;
        return out;
      })
      .join('\n');
    return { ...b, text };
  });
  const steps = pair.ir.steps.map((s): Step => {
    if (!scope.stepIds.includes(s.id)) return s;
    if (s.kind === 'shell' || s.kind === 'run') return { ...s, command: mapText(s.command, fn) };
    if (s.kind === 'write_file' || s.kind === 'append_file')
      return { ...s, content: mapText(s.content, fn) };
    return s;
  });
  if (!changed) return null;
  return { extraction: { ...pair.extraction, blocks }, ir: { ...pair.ir, steps } };
}

const blockOf = (pair: Pair, index: number): ExtractionBlock | undefined =>
  pair.extraction.blocks.find((b) => b.index === index);

/** Steps that write program text, with the block each one quotes. */
function codeSteps(
  pair: Pair,
): { step: Extract<Step, { kind: 'write_file' | 'append_file' }>; block: ExtractionBlock }[] {
  const out: {
    step: Extract<Step, { kind: 'write_file' | 'append_file' }>;
    block: ExtractionBlock;
  }[] = [];
  for (const step of pair.ir.steps) {
    if (step.kind !== 'write_file' && step.kind !== 'append_file') continue;
    const block = blockOf(pair, step.source.blockIndex);
    const isSource =
      pair.ir.language === 'node'
        ? /\.(?:[cm]?js|[cm]?ts)$/.test(step.path)
        : /\.py$/.test(step.path);
    if (block && isSource) out.push({ step, block });
  }
  return out;
}

/** Every step of the plan that writes text quoted from this block (so a rename stays consistent across them). */
const writersOf = (pair: Pair, blockIndex: number): string[] =>
  pair.ir.steps
    .filter(
      (s) =>
        (s.kind === 'write_file' || s.kind === 'append_file') && s.source.blockIndex === blockIndex,
    )
    .map((s) => s.id);

// ---------------------------------------------------------------- install commands (operators 1, 2, 8)

export interface InstallSite {
  step: Extract<Step, { kind: 'shell' }>;
  /** The package argument exactly as written, e.g. `ajv`, `@scope/pkg@1`, `'pkg[extra]>=2'`. */
  raw: string;
  name: string;
  /** Extras and any version specifier as written, e.g. `[extra]>=2` or `@1`. */
  rest: string;
  manager: 'npm' | 'pip';
}

const NPM_INSTALL = /\b(?:npm|pnpm|yarn|bun)\s+(?:i|install|add)\b([^&;|\n]*)/;
const PIP_INSTALL =
  /\b(?:pip3?\s+install|python3?\s+-m\s+pip\s+install|uv\s+pip\s+install|uv\s+add|poetry\s+add)\b([^&;|\n]*)/;

/** The first package a plan installs, from its first install step that quotes the docs. */
export function firstInstall(ir: StepIR): InstallSite | null {
  for (const step of ir.steps) {
    if (step.kind !== 'shell') continue;
    const npm = NPM_INSTALL.exec(step.command);
    const pip = npm ? null : PIP_INSTALL.exec(step.command);
    const m = npm ?? pip;
    if (!m) continue;
    const arg = (m[1] as string)
      .trim()
      .split(/\s+/)
      .find(
        (t) =>
          t !== '' &&
          !t.startsWith('-') &&
          !t.startsWith('.') &&
          !t.startsWith('/') &&
          !/^(?:git\+|https?:)/.test(t),
      );
    if (!arg) continue;
    const raw = arg;
    const bare = raw.replace(/^['"]|['"]$/g, '');
    if (npm) {
      const mm = /^(@[^/@]+\/[^@]+|[^@]+)(@.*)?$/.exec(bare);
      if (!mm) continue;
      return { step, raw, name: mm[1] as string, rest: mm[2] ?? '', manager: 'npm' };
    }
    const mm = /^([A-Za-z0-9][A-Za-z0-9_.-]*)(.*)$/.exec(bare);
    if (!mm) continue;
    return { step, raw, name: mm[1] as string, rest: mm[2] ?? '', manager: 'pip' };
  }
  return null;
}

/** Replaces the package argument in the install segment of a line, and only there. */
function installEdit(site: InstallSite, replacement: string): LineFn {
  const re = new RegExp(
    `((?:npm|pnpm|yarn|bun|pip3?|pip|uv|poetry)\\b[^&;|\\n]*?\\b(?:i|install|add)\\b[^&;|\\n]*?)(?<![\\w@/.\\[=<>~-])${esc(site.raw)}(?![\\w@/.-])`,
  );
  return (line) => line.replace(re, (_m, head: string) => `${head}${replacement}`);
}

function installMutation(
  pair: Pair,
  operator: OperatorId,
  newArg: (s: InstallSite) => string,
  change: (s: InstallSite, to: string) => string,
): Mutant | null {
  const site = firstInstall(pair.ir);
  if (!site) return null;
  const to = newArg(site);
  const edited = applyEdit(
    pair,
    {
      blockIndex: site.step.source.blockIndex,
      range: { from: site.step.source.lineStart, to: site.step.source.lineEnd },
      stepIds: [site.step.id],
    },
    installEdit(site, to),
  );
  return edited ? { operator, change: change(site, to), pair: edited } : null;
}

const typoName = (name: string): string => {
  const scoped = name.startsWith('@');
  const [scope, bare] = scoped ? (name.split('/') as [string, string]) : ['', name];
  const mid = Math.max(1, Math.floor(bare.length / 2));
  const typo = `${bare.slice(0, mid)}qq${bare.slice(mid)}`;
  return scoped ? `${scope}/${typo}` : typo;
};

const pkgTypo = (pair: Pair): Mutant | null =>
  installMutation(
    pair,
    'pkg_typo',
    (s) => {
      const quote = /^['"]/.test(s.raw) ? s.raw[0] : '';
      return `${quote}${typoName(s.name)}${s.rest}${quote}`;
    },
    (s, to) => `${s.raw} -> ${to}`,
  );

const versionPin = (pair: Pair): Mutant | null =>
  installMutation(
    pair,
    'version_pin',
    (s) => {
      const quote = /^['"]/.test(s.raw) ? s.raw[0] : '';
      const extras = /^(\[[^\]]+\])/.exec(s.rest)?.[1] ?? '';
      return s.manager === 'npm'
        ? `${quote}${s.name}@999.999.999${quote}`
        : `${quote}${s.name}${extras}==999.999.999${quote}`;
    },
    (s, to) => `${s.raw} -> ${to}`,
  );

// ---------------------------------------------------------------- imports (operators 3, 5)

interface Binding {
  step: Extract<Step, { kind: 'write_file' | 'append_file' }>;
  block: ExtractionBlock;
  line: string;
  module: string;
  /** The name as the package exports it (the part before `as`, or the object key before `:`). */
  name: string;
  /** Renaming the import side only (an alias keeps the local name), or the local name too. */
  aliased: boolean;
}

const bareNode = (spec: string): boolean =>
  !/^(?:\.|\/|#)/.test(spec) && !BUILTINS.has(spec) && !spec.startsWith('node:');
const bareModule = (spec: string, language: StepIR['language']): boolean =>
  language === 'node'
    ? bareNode(spec)
    : !PY_STDLIB.has(spec.split('.')[0] as string) && !spec.startsWith('.');
const IDENT = /^[A-Za-z_$][\w$]*$/;

const ESM_NAMED =
  /^\s*import\s+(?:type\s+)?(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/;
const CJS_DESTRUCT = /^\s*(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/;
const PY_FROM =
  /^\s*from\s+([A-Za-z_][\w.]*)\s+import\s+([A-Za-z_][\w]*(?:\s+as\s+\w+)?(?:\s*,\s*[A-Za-z_]\w*(?:\s+as\s+\w+)?)*)\s*$/;

function namedBindings(pair: Pair): Binding[] {
  const out: Binding[] = [];
  for (const { step, block } of codeSteps(pair)) {
    for (const line of lines(block.text)) {
      if (isCommentLine(line)) continue;
      if (pair.ir.language === 'node') {
        const esm = ESM_NAMED.exec(line);
        const cjs = esm ? null : CJS_DESTRUCT.exec(line);
        const m = esm ?? cjs;
        if (!m || !bareModule(m[2] as string, 'node')) continue;
        for (const part of (m[1] as string).split(',')) {
          const t = part.trim().replace(/^type\s+/, '');
          const alias = esm
            ? /^([\w$]+)\s+as\s+([\w$]+)$/.exec(t)
            : /^([\w$]+)\s*:\s*([\w$]+)$/.exec(t);
          const name = alias ? (alias[1] as string) : t.replace(/\s*=.*$/, '');
          if (IDENT.test(name) && name !== 'default')
            out.push({ step, block, line, module: m[2] as string, name, aliased: alias !== null });
        }
      } else {
        const m = PY_FROM.exec(line);
        if (!m || !bareModule(m[1] as string, 'python')) continue;
        for (const part of (m[2] as string).split(',')) {
          const alias = /^\s*(\w+)\s+as\s+(\w+)\s*$/.exec(part);
          const name = (alias ? (alias[1] as string) : part.trim()).trim();
          if (IDENT.test(name))
            out.push({ step, block, line, module: m[1] as string, name, aliased: alias !== null });
        }
      }
    }
  }
  return out;
}

const renamedSymbol = (pair: Pair, rng: Rng, same: Same): Mutant | null => {
  const pick = rng.pick(namedBindings(pair));
  if (!pick) return null;
  const to = pair.ir.language === 'node' ? `${pick.name}Qsr` : `${pick.name}_qsr`;
  const word = new RegExp(`(?<![\\w$.])${esc(pick.name)}(?![\\w$])`, 'g');
  // An alias keeps the local name, so only the imported side of that one line changes; otherwise every use follows it.
  const importOnly = new RegExp(`(?<![\\w$.])${esc(pick.name)}(?=\\s+as\\s|\\s*:\\s*[\\w$])`);
  const fn: LineFn = pick.aliased
    ? (l) => (same(l, pick.line) ? l.replace(importOnly, to) : l)
    : (l) => l.replace(word, to);
  const edited = applyEdit(
    pair,
    { blockIndex: pick.block.index, stepIds: writersOf(pair, pick.block.index) },
    fn,
  );
  return edited
    ? {
        operator: 'renamed_symbol',
        change: `${pick.name} -> ${to} (from '${pick.module}')`,
        pair: edited,
      }
    : null;
};

const ESM_FROM = /(\bfrom\s*)(['"])([^'"]+)\2/;
const CJS_REQUIRE = /(\brequire\(\s*)(['"])([^'"]+)\2/;
const PY_IMPORT = /^(\s*import\s+)([A-Za-z_][\w]*)(\s*(?:#.*)?)$/;
const PY_FROM_MODULE = /^(\s*from\s+)([A-Za-z_][\w]*)(\s+import\s+.+)$/;

const deepImport = (pair: Pair, rng: Rng, same: Same): Mutant | null => {
  const cands: { block: ExtractionBlock; line: string; spec: string }[] = [];
  for (const { block } of codeSteps(pair)) {
    for (const line of lines(block.text)) {
      if (isCommentLine(line)) continue;
      if (pair.ir.language === 'node') {
        const m =
          ESM_FROM.exec(line) ?? (/\bimport\s*['"]/.test(line) ? null : CJS_REQUIRE.exec(line));
        if (m && bareNode(m[3] as string) && !/\.[cm]?[jt]s$|\.json$/.test(m[3] as string))
          cands.push({ block, line, spec: m[3] as string });
      } else {
        const m = PY_IMPORT.exec(line) ?? PY_FROM_MODULE.exec(line);
        if (m && bareModule(m[2] as string, 'python'))
          cands.push({ block, line, spec: m[2] as string });
      }
    }
  }
  const pick = rng.pick(cands);
  if (!pick) return null;
  const to =
    pair.ir.language === 'node' ? `${pick.spec}/dist/qsr-missing` : `${pick.spec}.qsr_missing`;
  const fn: LineFn =
    pair.ir.language === 'node'
      ? (l) =>
          same(l, pick.line)
            ? l.replace(
                new RegExp(`(['"])${esc(pick.spec)}\\1`),
                (_m, q: string) => `${q}${to}${q}`,
              )
            : l
      : (l) =>
          same(l, pick.line)
            ? l.replace(new RegExp(`(\\b(?:import|from)\\s+)${esc(pick.spec)}\\b`), `$1${to}`)
            : l;
  const edited = applyEdit(
    pair,
    { blockIndex: pick.block.index, stepIds: writersOf(pair, pick.block.index) },
    fn,
  );
  return edited ? { operator: 'deep_import', change: `${pick.spec} -> ${to}`, pair: edited } : null;
};

// ---------------------------------------------------------------- calls (operators 4, 7) and syntax (6)

const NOT_A_CLIENT = new Set(
  'console JSON Math Object Array Promise process Date Number String path fs os assert Buffer Reflect Symbol util Error module exports global window document self this super'.split(
    ' ',
  ),
);
const COMMON_METHODS = new Set(
  'then catch finally log error warn info debug push pop map filter reduce forEach join split slice includes toString stringify parse keys values entries assign resolve reject all trim replace startsWith endsWith append format items get update lower upper strip run exit write end on once off emit close'.split(
    ' ',
  ),
);

function declaredObjects(text: string, language: StepIR['language']): Set<string> {
  const out = new Set<string>();
  for (const line of lines(text)) {
    if (isCommentLine(line)) continue;
    const m =
      language === 'node'
        ? /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?(?:new\s+)?[\w$.]+\s*\(/.exec(
            line,
          )
        : (/^\s*([A-Za-z_]\w*)\s*=\s*(?:await\s+)?[\w.]+\s*\(/.exec(line) ??
          /\bas\s+([A-Za-z_]\w*)\s*:\s*$/.exec(line));
    if (m && !NOT_A_CLIENT.has(m[1] as string)) out.add(m[1] as string);
  }
  return out;
}

const renamedMethod = (pair: Pair, rng: Rng): Mutant | null => {
  // `obj.method(` and chained calls such as `client.messages.create(`: the LAST name before the bracket is renamed.
  const cands: { block: ExtractionBlock; obj: string; chain: string; method: string }[] = [];
  for (const { block } of codeSteps(pair)) {
    const objs = declaredObjects(block.text, pair.ir.language);
    for (const line of lines(block.text)) {
      if (isCommentLine(line)) continue;
      for (const m of line.matchAll(
        /(?<![\w$.])([A-Za-z_$][\w$]*)((?:\.[A-Za-z_$][\w$]*)*)\.([A-Za-z_$][\w$]*)\s*\(/g,
      )) {
        if (objs.has(m[1] as string) && !COMMON_METHODS.has(m[3] as string))
          cands.push({
            block,
            obj: m[1] as string,
            chain: m[2] as string,
            method: m[3] as string,
          });
      }
    }
  }
  const pick = rng.pick(cands);
  if (!pick) return null;
  const to = pair.ir.language === 'node' ? `${pick.method}Qsr` : `${pick.method}_qsr`;
  const re = new RegExp(
    `(?<![\\w$.])${esc(pick.obj)}${esc(pick.chain)}\\.${esc(pick.method)}(?=\\s*\\()`,
    'g',
  );
  const edited = applyEdit(
    pair,
    { blockIndex: pick.block.index, stepIds: writersOf(pair, pick.block.index) },
    (l) => l.replace(re, `${pick.obj}${pick.chain}.${to}`),
  );
  return edited
    ? {
        operator: 'renamed_method',
        change: `${pick.obj}${pick.chain}.${pick.method}( -> ${pick.obj}${pick.chain}.${to}(`,
        pair: edited,
      }
    : null;
};

const syntaxError = (pair: Pair, rng: Rng, same: Same): Mutant | null => {
  const cands: { block: ExtractionBlock; line: string; kind: 'bracket' | 'quote' }[] = [];
  for (const { block } of codeSteps(pair)) {
    for (const line of lines(block.text)) {
      if (isCommentLine(line) || line.trim().length < 4) continue;
      if (/\(.*\)/.test(line)) cands.push({ block, line, kind: 'bracket' });
      else if (/['"]\s*[;,)]?\s*$/.test(line)) cands.push({ block, line, kind: 'quote' });
    }
  }
  const pick = rng.pick(cands);
  if (!pick) return null;
  const mutate: LineFn =
    pick.kind === 'bracket'
      ? (l) =>
          same(l, pick.line) ? l.slice(0, l.lastIndexOf(')')) + l.slice(l.lastIndexOf(')') + 1) : l
      : (l) => {
          if (!same(l, pick.line)) return l;
          const at = Math.max(l.lastIndexOf('"'), l.lastIndexOf("'"));
          return l.slice(0, at) + l.slice(at + 1);
        };
  const edited = applyEdit(
    pair,
    { blockIndex: pick.block.index, stepIds: writersOf(pair, pick.block.index) },
    mutate,
  );
  return edited
    ? {
        operator: 'syntax_error',
        change: `${pick.kind === 'bracket' ? 'closing bracket' : 'closing quote'} removed from: ${pick.line.trim().slice(0, 80)}`,
        pair: edited,
      }
    : null;
};

const optionMisnamed = (pair: Pair, rng: Rng, same: Same): Mutant | null => {
  const cands: { block: ExtractionBlock; line: string; key: string }[] = [];
  for (const { block } of codeSteps(pair)) {
    let depth = 0;
    for (const line of lines(block.text)) {
      const before = depth;
      for (const ch of line)
        depth +=
          ch === '(' || ch === '{' || ch === '['
            ? 1
            : ch === ')' || ch === '}' || ch === ']'
              ? -1
              : 0;
      if (isCommentLine(line)) continue;
      const kw =
        pair.ir.language === 'node'
          ? ((before > 0 ? /^\s+([A-Za-z_$][\w$]*)\s*:\s*\S/.exec(line) : null) ??
            /[({,]\s*([A-Za-z_$][\w$]*)\s*:\s*[^:]/.exec(line.includes('(') ? line : ''))
          : ((before > 0 ? /^\s+([A-Za-z_]\w*)\s*=(?!=)\s*\S/.exec(line) : null) ??
            /[(,]\s*([A-Za-z_]\w*)=(?!=)/.exec(line.includes('(') ? line : ''));
      if (kw && !['http', 'https'].includes(kw[1] as string))
        cands.push({ block, line, key: kw[1] as string });
    }
  }
  const pick = rng.pick(cands);
  if (!pick) return null;
  const to = pair.ir.language === 'node' ? `${pick.key}Qsr` : `${pick.key}_qsr`;
  const re =
    pair.ir.language === 'node'
      ? new RegExp(`(?<![\\w$.])${esc(pick.key)}(?=\\s*:)`)
      : new RegExp(`(?<![\\w$.])${esc(pick.key)}(?=\\s*=(?!=))`);
  const edited = applyEdit(
    pair,
    { blockIndex: pick.block.index, stepIds: writersOf(pair, pick.block.index) },
    (l) => (same(l, pick.line) ? l.replace(re, to) : l),
  );
  return edited
    ? {
        operator: 'option_misnamed',
        change: `option ${pick.key} -> ${to} in: ${pick.line.trim().slice(0, 80)}`,
        pair: edited,
      }
    : null;
};

// ---------------------------------------------------------------- the registry

/** Applies one operator to a valid (extraction, plan) pair, or null when the plan has no site for it. */
export function applyOperator(
  id: Exclude<OperatorId, 'previous_major'>,
  pair: Pair,
  rng: Rng,
  placeholders: Readonly<Record<string, string>> = {},
): Mutant | null {
  const same = sameLine(placeholders);
  switch (id) {
    case 'pkg_typo':
      return pkgTypo(pair);
    case 'version_pin':
      return versionPin(pair);
    case 'renamed_symbol':
      return renamedSymbol(pair, rng, same);
    case 'renamed_method':
      return renamedMethod(pair, rng);
    case 'deep_import':
      return deepImport(pair, rng, same);
    case 'syntax_error':
      return syntaxError(pair, rng, same);
    case 'option_misnamed':
      return optionMisnamed(pair, rng, same);
  }
}

// ---------------------------------------------------------------- operator 8 (an executor override, no docs mutation)

/** The major version the control resolved for a package (`runnerEnv.resolved`, a name to version map), or null. */
export function resolvedMajor(
  resolved: Readonly<Record<string, string>>,
  name: string,
): number | null {
  const norm = (n: string): string => n.toLowerCase().replace(/[-_.]+/g, '-');
  const key = Object.keys(resolved).find((k) => norm(k) === norm(name));
  const m = key === undefined ? null : /^v?(\d+)\./.exec(resolved[key] as string);
  return m ? Number(m[1]) : null;
}

/**
 * The plan with its first install argument pinned to the previous major version, for the experiment. The docs lines
 * are NOT changed: the plan is no longer a quotation, so this plan is run directly (an executor override) and is never
 * shown to the grounding validator.
 */
export function previousMajorPlan(
  ir: StepIR,
  major: number,
): { ir: StepIR; change: string } | null {
  const site = firstInstall(ir);
  if (!site || major < 1) return null;
  const prev = major - 1;
  const quote = /^['"]/.test(site.raw) ? site.raw[0] : '';
  const to =
    site.manager === 'npm' ? `${quote}${site.name}@${prev}${quote}` : `'${site.name}<${major}'`;
  const fn = installEdit(site, to);
  const steps = ir.steps.map((s): Step =>
    s.id === site.step.id && s.kind === 'shell' ? { ...s, command: mapText(s.command, fn) } : s,
  );
  return { ir: { ...ir, steps }, change: `${site.raw} -> ${to}` };
}
