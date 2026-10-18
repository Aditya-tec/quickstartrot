// The harness-owned scripts behind the `harness_check` steps (spec section 6: level 2 means the
// snippet imports or compiles). They are constants in this repository, written to the container's
// stdin; they never come from the model or from the docs. They only READ files under /work and never
// execute the snippet or import the packages it imports.
//
// Contract with the executor: exit 0 = everything checked is fine, exit 1 = findings in the docs'
// code (printed to stderr, one per line, `file:line: message`), exit 2 = the script itself broke,
// exit 3 = the check cannot be performed here (e.g. no TypeScript compiler). Anything but 0 or 1 is a
// harness error, never a verdict on the docs.
//
// Written with String.raw: no backticks and no dollar-brace sequences inside.

/**
 * Node. Run as `node --input-type=module - <syntax|imports> <files...>` from /work.
 *
 * syntax:  `node --check` for .js/.mjs/.cjs (version 2: and a .js file that uses import is also parsed as a module, because
 *          node --check does not parse it otherwise). For .ts/.mts/.cts: `tsc --noEmit --noResolve` (the
 *          project's own typescript if installed, else the image's global one), keeping ONLY the
 *          syntactic diagnostics (TS1xxx). A full type check is deliberately not used: a snippet is
 *          not a project, so it has no tsconfig and none of the @types packages a type check needs,
 *          and correct code would fail. The `tsx` global has no check mode, so it is not used.
 * imports: every STATIC import / export-from / require('literal') specifier. `node:` and builtins pass;
 *          relative ones must exist on disk; bare ones must resolve from /work/node_modules (the ESM
 *          resolver, then the CJS one). Dynamic import(), non-literal require(), and package.json
 *          "imports" aliases (#x) are NOT checked. Also: require() in an ES module is a failure.
 */
export const NODE_CHECK_SCRIPT = String.raw`import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire, isBuiltin } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [mode, ...files] = process.argv.slice(2);
const cwd = process.cwd();
const req = createRequire(path.join(cwd, 'qsr-noop.js'));
const problems = [];
const fail = (where, message) => problems.push(where + ': ' + message);
const isTs = (f) => /\.[cm]?ts$/.test(f);
const abs = (f) => path.resolve(cwd, f);

function findTsc() {
  const candidates = [
    path.join(cwd, 'node_modules', 'typescript', 'bin', 'tsc'),
    path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'typescript', 'bin', 'tsc'),
  ];
  return candidates.find((c) => existsSync(c)) ?? null;
}

function checkTypescript(tsFiles) {
  const tsc = findTsc();
  if (tsc === null) {
    console.error('qsr: the TypeScript compiler (tsc) is not available, so ' + tsFiles.join(', ') + ' cannot be syntax-checked');
    process.exit(3);
  }
  // No tsconfig and no @types exist for a docs snippet, so a full type check would fail correct code.
  // Run tsc without module resolution and keep only the syntactic diagnostics (TS1xxx).
  const r = spawnSync(
    process.execPath,
    [tsc, '--noEmit', '--noResolve', '--pretty', 'false', '--target', 'es2022', '--module', 'esnext', '--moduleResolution', 'bundler', '--skipLibCheck', ...tsFiles],
    { cwd, encoding: 'utf8' },
  );
  const output = String(r.stdout) + String(r.stderr);
  if (r.error || /error TS5\d{3}/.test(output) || (r.status !== 0 && !/error TS\d+/.test(output)))
    throw new Error('tsc could not check the files: ' + (r.error ? r.error.message : output.slice(0, 400)));
  for (const line of output.split(/\r?\n/)) {
    const m = /^(.+?)\((\d+),\d+\): error TS(1\d{3}): (.*)$/.exec(line);
    if (m) fail(m[1] + ':' + m[2], 'SyntaxError: ' + m[4] + ' (TS' + m[3] + ')');
  }
}

// Harness version 2. Found by qsr mutate (P9c): "node --check" exits 0 for a .js file that uses import when no package.json says
// "type": "module" (Node detects the module syntax, then checks nothing), so a broken ES-module .js file passed this check.
// Such a file is parsed here as a module, from a copy named .mjs. Files that already are modules (.mjs, or a package of type
// module) were parsed as modules by node --check and are left alone.
let esmCopies = 0;
const esmDir = [];
function checkEsmSyntax(f) {
  if (!/\.js$/.test(f)) return;
  const src = readFileSync(abs(f), 'utf8');
  if (packageType(f) === 'module' || !isEsm(f, src)) return;
  if (esmDir.length === 0) esmDir.push(mkdtempSync(path.join(tmpdir(), 'qsr-esm-')));
  const copy = path.join(esmDir[0], 'esm-' + esmCopies++ + '.mjs');
  writeFileSync(copy, src);
  const r = spawnSync(process.execPath, ['--check', copy], { cwd, encoding: 'utf8' });
  if (r.status !== 0) {
    const detail = r.stderr
      .split('\n')
      .filter((l) => !/^\s+at /.test(l) && !/^Node\.js v/.test(l))
      .join('\n')
      .split(copy)
      .join(f)
      .trim();
    fail(f, '\n' + detail);
  }
}

function checkSyntax() {
  const tsFiles = [];
  for (const f of files) {
    if (!existsSync(abs(f))) {
      fail(f, 'file not found');
    } else if (isTs(f)) {
      tsFiles.push(f);
    } else {
      const r = spawnSync(process.execPath, ['--check', f], { cwd, encoding: 'utf8' });
      if (r.status !== 0) {
        const detail = r.stderr
          .split('\n')
          .filter((l) => !/^\s+at /.test(l) && !/^Node\.js v/.test(l))
          .join('\n')
          .trim();
        fail(f, '\n' + detail);
      } else {
        checkEsmSyntax(f);
      }
    }
  }
  if (tsFiles.length > 0) checkTypescript(tsFiles);
}

// Blank out comments but keep their newlines, so reported line numbers stay right.
const stripComments = (s) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ''))
    .replace(/(^|[^:'"\\])\/\/[^\n]*/gm, '$1');
const lineOf = (src, index) => src.slice(0, index).split('\n').length;

const IMPORT_RE = /^[ \t]*import\s+(?!type\b)(?:[\w$*{}\s,]+?\s+from\s+)?(['"])([^'"\n]+)\1/gm;
const EXPORT_RE = /^[ \t]*export\s+(?!type\b)(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s+from\s+(['"])([^'"\n]+)\1/gm;
const REQUIRE_RE = /\brequire\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g;
const ANY_REQUIRE_RE = /(?<![.\w$])require\s*\(/;
const OWN_REQUIRE_RE = /\b(?:createRequire|(?:const|let|var|function)\s+require\b)/;
const ESM_SYNTAX_RE = /^[ \t]*(?:import\s+[\w$*{'"]|export\s+(?:default|const|let|var|function|class|async|\{|\*))|\bimport\.meta\b/m;
const EXTENSIONS = ['.js', '.mjs', '.cjs', '.json', '.node', '.ts', '.mts', '.cts'];
const isFile = (p) => existsSync(p) && statSync(p).isFile();
const isDir = (p) => existsSync(p) && statSync(p).isDirectory();

function packageType(file) {
  let dir = path.dirname(abs(file));
  for (;;) {
    const pj = path.join(dir, 'package.json');
    if (isFile(pj)) {
      try {
        return JSON.parse(readFileSync(pj, 'utf8')).type ?? null;
      } catch {
        return null;
      }
    }
    const up = path.dirname(dir);
    if (up === dir || !dir.startsWith(cwd)) return null;
    dir = up;
  }
}

function isEsm(file, src) {
  if (/\.m[jt]s$/.test(file)) return true;
  if (/\.c[jt]s$/.test(file)) return false;
  const type = packageType(file);
  if (type === 'module') return true;
  if (type === 'commonjs') return false;
  return ESM_SYNTAX_RE.test(src);
}

function resolveRelative(spec, file, strictExtension) {
  const base = path.resolve(path.dirname(abs(file)), spec);
  if (isFile(base)) return true;
  if (strictExtension) return false;
  const tries = [
    ...EXTENSIONS.map((e) => base + e),
    ...EXTENSIONS.map((e) => path.join(base, 'index' + e)),
    base.replace(/\.js$/, '.ts'),
    base.replace(/\.mjs$/, '.mts'),
    base.replace(/\.cjs$/, '.cts'),
  ];
  return tries.some(isFile) || (isDir(base) && isFile(path.join(base, 'package.json')));
}

const packageName = (spec) => spec.split('/').slice(0, spec.startsWith('@') ? 2 : 1).join('/');

// import.meta.resolve returns a URL for a deep import into a package WITHOUT an exports map without
// checking the file exists, so the file is checked here. An ES module importer gets the ESM resolver
// only (Node resolves nothing else for it); a CommonJS or TypeScript importer may also use require's.
function resolveBare(spec, strictEsm) {
  let esmError;
  try {
    const url = import.meta.resolve(spec);
    const file = url.startsWith('file:') ? fileURLToPath(url) : null;
    if (file === null || isFile(file)) return null;
    esmError = Object.assign(new Error("Cannot find module '" + file + "'"), { code: 'ERR_MODULE_NOT_FOUND' });
  } catch (error) {
    esmError = error;
  }
  if (strictEsm) return esmError;
  try {
    req.resolve(spec);
    return null;
  } catch {
    return esmError;
  }
}

function checkImports() {
  for (const f of files) {
    if (!existsSync(abs(f))) {
      fail(f, 'file not found');
      continue;
    }
    const src = stripComments(readFileSync(abs(f), 'utf8'));
    const esm = isEsm(f, src);
    const ts = isTs(f);
    if (esm && !ts && ANY_REQUIRE_RE.test(src) && !OWN_REQUIRE_RE.test(src)) {
      const m = ANY_REQUIRE_RE.exec(src);
      fail(f + ':' + lineOf(src, m.index), 'ReferenceError: require is not defined in ES module scope, you can use import instead');
    }
    const found = [];
    for (const re of [IMPORT_RE, EXPORT_RE]) for (const m of src.matchAll(re)) found.push([m[2], m.index]);
    if (!(esm && !ts)) for (const m of src.matchAll(REQUIRE_RE)) found.push([m[2], m.index]);
    for (const [spec, index] of found) {
      const where = f + ':' + lineOf(src, index);
      if (isBuiltin(spec) || spec.startsWith('#')) continue;
      if (spec.startsWith('.') || spec.startsWith('/')) {
        if (!resolveRelative(spec, f, esm && !ts))
          fail(where, "Cannot find module '" + spec + "' imported from " + f + (esm && !ts ? ' (ES modules need the full file name, extension included)' : ''));
        continue;
      }
      const error = resolveBare(spec, esm && !ts);
      if (error === null) continue;
      fail(
        where,
        error.code === 'ERR_MODULE_NOT_FOUND' && !/imported from .*node_modules/.test(String(error.message)) && !/Cannot find module/.test(String(error.message))
          ? "Cannot find package '" + packageName(spec) + "' imported from " + f
          : String(error.message).replace(/ imported from .*$/, '') + ' (imported from ' + f + ')',
      );
    }
  }
}

// exports (experimental, off unless the executor is asked for it): for every static NAMED import of an installed package
// (import { A } from 'pkg', or const { A } = require('pkg')), load the package once, in this process, and check that it
// exports A. This is the only check that executes package code (an import runs the module body), so it runs with the
// network blocked in-process (sockets, DNS and fetch throw) and never calls anything the package exports. TypeScript (a .ts file,
// or code with TypeScript-only syntax) is checked only for the names it USES AS A VALUE: a name that appears only after a colon, in
// angle brackets, after as, extends or implements is a type, and a type has no run-time export. A package that cannot be loaded here
// is reported as unchecked, never as a failure of the docs.
const NAMED_ESM_RE = /^[ \t]*import\s+(?!type\b)(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s*(['"])([^'"\n]+)\2/gm;
const NAMED_CJS_RE = /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\s*\(\s*(['"])([^'"\n]+)\2\s*\)/g;

async function blockNetwork() {
  const refuse = () => {
    throw new Error('qsr-check-exports: the network is blocked while packages are loaded');
  };
  // CommonJS module objects are writable (the ES namespace objects are not); the ES builtins are then re-synced from them.
  const net = req('node:net');
  net.Socket.prototype.connect = refuse;
  const dns = req('node:dns');
  for (const name of ['lookup', 'resolve', 'resolve4', 'resolve6']) {
    dns[name] = refuse;
    dns.promises[name] = refuse;
  }
  globalThis.fetch = refuse;
  const { syncBuiltinESMExports } = await import('node:module');
  syncBuiltinESMExports();
}

// TypeScript-only syntax: any one of these means the snippet is TypeScript whatever its file extension says.
const TS_SIGNALS = [
  /^\s*(?:export\s+)?(?:interface|enum|namespace|declare)\s+[\w$]+/m,
  /^\s*(?:export\s+)?type\s+[\w$]+(?:<[^>\n]*>)?\s*=/m,
  /\bimport\s+type\b/,
  /\bimport\s*\{[^}]*\btype\s+[\w$]+/,
  /\bas\s+const\b/,
  /\b(?:const|let|var)\s+[\w$]+\s*:\s*[A-Za-z_$][\w$.<>\[\]| ]*\s*=/,
  /\)\s*:\s*[A-Za-z_$][\w$.<>\[\]| ]*\s*(?:=>|\{)/,
  /\bimplements\s+[\w$]/,
];
const looksLikeTypeScript = (file, src) => isTs(file) || TS_SIGNALS.some((re) => re.test(src));
const TYPE_POSITION = /(?::\s*|<\s*|\bas\s+|\bextends\s+|\bimplements\s+|\|\s*|&\s*)$/;

// A name is used as a value when it appears outside its own import statement and outside a type position.
function usedAsValue(rest, name) {
  const re = new RegExp('(?<![\\w$.])' + name.replace(/\$/g, '\\$') + '(?![\\w$])', 'g');
  for (const m of rest.matchAll(re)) {
    if (!TYPE_POSITION.test(rest.slice(Math.max(0, m.index - 24), m.index))) return true;
    // "key: name(...)": a call is a value even right after a colon (a type is never called)
    if (/^\s*\(/.test(rest.slice(m.index + name.length, m.index + name.length + 8))) return true;
  }
  return false;
}

function namedBindings(list) {
  const names = [];
  for (const part of list.split(',')) {
    const t = part.trim();
    if (t === '' || /^type\s/.test(t)) continue;
    const name = t.split(/\s+as\s+|\s*:\s*/)[0].replace(/\s*=.*$/, '').trim();
    if (/^[A-Za-z_$][\w$]*$/.test(name) && name !== 'default') names.push(name);
  }
  return names;
}

async function checkExports() {
  await blockNetwork();
  const cache = new Map();
  const unchecked = [];
  for (const f of files) {
    if (!existsSync(abs(f))) continue;
    const src = stripComments(readFileSync(abs(f), 'utf8'));
    const esm = isEsm(f, src);
    const typed = looksLikeTypeScript(f, src);
    const rest = typed ? src.replace(NAMED_ESM_RE, (m) => ' '.repeat(m.length)).replace(NAMED_CJS_RE, (m) => ' '.repeat(m.length)) : '';
    const sites = [];
    for (const re of [NAMED_ESM_RE, NAMED_CJS_RE]) for (const m of src.matchAll(re)) sites.push({ names: namedBindings(m[1]), spec: m[3], index: m.index, cjs: re === NAMED_CJS_RE });
    for (const site of sites) {
      const { spec } = site;
      if (isBuiltin(spec) || spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('#') || site.names.length === 0) continue;
      const key = (esm && !site.cjs ? 'esm:' : 'cjs:') + spec;
      if (!cache.has(key)) {
        try {
          cache.set(key, esm && !site.cjs ? await import(spec) : req(spec));
        } catch (error) {
          cache.set(key, null);
          unchecked.push(spec + ' (' + String(error && error.message ? error.message : error).split('\n')[0] + ')');
        }
      }
      const mod = cache.get(key);
      if (mod === null || mod === undefined) continue;
      for (const name of site.names) {
        if (typed && !usedAsValue(rest, name)) continue; // a type: it has no run-time export
        // TypeScript is usually run through a loader that also lets it take a name from a CommonJS package, so a name found by either route counts
        if (typed && !(name in Object(mod))) {
          try {
            if (name in Object(req(spec))) continue;
          } catch {
            /* not loadable as CommonJS: the ES module answer stands */
          }
        }
        if (!(name in Object(mod))) fail(f + ':' + lineOf(src, site.index), "qsr-check-exports: '" + spec + "' does not export '" + name + "' (imported from " + f + ')');
      }
    }
  }
  if (unchecked.length > 0) console.log('qsr-check-exports: not checked, the package could not be loaded here: ' + [...new Set(unchecked)].join('; '));
}

try {
  if (mode === 'syntax') checkSyntax();
  else if (mode === 'imports') checkImports();
  else if (mode === 'exports') await checkExports();
  else throw new Error('unknown mode ' + mode);
} catch (err) {
  console.error('qsr: harness check crashed: ' + (err && err.stack ? err.stack : err));
  process.exit(2);
}
if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('ok ' + mode + ' ' + files.join(' '));
`;

/**
 * Python. Run as `python - <syntax|imports> <files...>` from /work.
 *
 * syntax:  `python -m py_compile` on every file (bytecode goes to a throwaway PYTHONPYCACHEPREFIX).
 * imports: every static import found with `ast`; the TOP-LEVEL module of each must be found by
 *          `importlib.util.find_spec` (installed packages, the stdlib, or a module written next to the
 *          importing file or under /work). Relative imports must point at a written file or package.
 *          An import inside a try whose handlers catch ImportError/Exception is optional and skipped.
 *          Version 2: a dotted path (import pkg.sub, from pkg.sub import x) must also resolve, one parent at a time,
 *          with find_spec for the top-level name and PathFinder for each child (directories are read, nothing is imported).
 *          find_spec of a top-level name imports nothing; neither the snippet nor the vendor package
 *          is executed. importlib.import_module() and __import__() are NOT checked.
 */
export const PYTHON_CHECK_SCRIPT = String.raw`import ast
import importlib.machinery
import importlib.util
import os
import re
import subprocess
import sys
import tempfile
import traceback

mode, files = sys.argv[1], sys.argv[2:]
cwd = os.getcwd()
problems = []


def fail(where, message):
    problems.append(where + ': ' + message)


def check_syntax():
    with tempfile.TemporaryDirectory() as cache:
        env = dict(os.environ, PYTHONPYCACHEPREFIX=cache)
        for f in files:
            if not os.path.isfile(f):
                fail(f, 'file not found')
                continue
            r = subprocess.run([sys.executable, '-m', 'py_compile', f], capture_output=True, text=True, env=env)
            if r.returncode != 0:
                fail(f, '\n' + (r.stderr or r.stdout).strip())


TRY_NODES = tuple(getattr(ast, n) for n in ('Try', 'TryStar') if hasattr(ast, n))
OPTIONAL_ERRORS = ('ImportError', 'ModuleNotFoundError', 'Exception', 'BaseException')


def handlers_catch_import_errors(handlers):
    for h in handlers:
        if h.type is None:
            return True
        for n in h.type.elts if isinstance(h.type, ast.Tuple) else [h.type]:
            name = n.id if isinstance(n, ast.Name) else n.attr if isinstance(n, ast.Attribute) else None
            if name in OPTIONAL_ERRORS:
                return True
    return False


def collect(node, optional, out):
    if isinstance(node, ast.Import):
        out.extend((node.lineno, 0, a.name, optional) for a in node.names)
    elif isinstance(node, ast.ImportFrom):
        out.append((node.lineno, node.level, node.module, optional))
    elif isinstance(node, TRY_NODES):
        covered = optional or handlers_catch_import_errors(node.handlers)
        for s in node.body:
            collect(s, covered, out)
        for h in node.handlers:
            collect(h, optional, out)
        for s in node.orelse + node.finalbody:
            collect(s, optional, out)
    else:
        for child in ast.iter_child_nodes(node):
            collect(child, optional, out)


def module_exists(top, file):
    saved = list(sys.path)
    sys.path[:0] = [os.path.dirname(os.path.abspath(file)), cwd]
    try:
        importlib.invalidate_caches()
        return importlib.util.find_spec(top) is not None
    except (ImportError, ValueError):
        return False
    finally:
        sys.path[:] = saved


def builds_submodules_dynamically(spec):
    # A package that registers submodules at run time (six.moves), loads them lazily (a module-level __getattr__) or installs an
    # import hook has children that are not files, so the absence of a file proves nothing. Read its __init__ as text; never run it.
    origin = getattr(spec, 'origin', None)
    if not origin or not os.path.isfile(origin):
        return False
    try:
        with open(origin, encoding='utf-8', errors='ignore') as fh:
            text = fh.read(300000)
    except OSError:
        return False
    return re.search(r'sys\.modules\[|__getattr__|meta_path|LazyModule|lazy_import', text) is not None


def dotted_status(name, file):
    # Harness version 2. Resolve the FULL dotted path of an import, one parent at a time, without importing any of them:
    # find_spec of the top-level name imports nothing, and each next part is looked up in the parent's search locations with
    # PathFinder, which only reads directories. Returns 'found', 'missing' (the parent is a package and has no such child) or
    # 'unknown' (not decidable here: a standard-library module, a parent that is not a package, a namespace oddity).
    parts = name.split('.')
    if parts[0] in getattr(sys, 'stdlib_module_names', ()):
        return 'unknown'
    saved = list(sys.path)
    sys.path[:0] = [os.path.dirname(os.path.abspath(file)), cwd]
    try:
        importlib.invalidate_caches()
        spec = importlib.util.find_spec(parts[0])
        if spec is None:
            return 'missing'
        for i in range(1, len(parts)):
            locations = spec.submodule_search_locations
            if locations is None:
                return 'unknown'
            if builds_submodules_dynamically(spec):
                return 'unknown'
            spec = importlib.machinery.PathFinder.find_spec('.'.join(parts[: i + 1]), list(locations))
            if spec is None:
                return 'missing'
        return 'found'
    except (ImportError, ValueError, AttributeError):
        return 'unknown'
    finally:
        sys.path[:] = saved


def relative_exists(level, module, file):
    base = os.path.dirname(os.path.abspath(file))
    for _ in range(level - 1):
        base = os.path.dirname(base)
    if not module:
        return True
    target = os.path.join(base, *module.split('.'))
    return os.path.isfile(target + '.py') or os.path.isdir(target)


def check_imports():
    for f in files:
        if not os.path.isfile(f):
            fail(f, 'file not found')
            continue
        try:
            with open(f, encoding='utf-8') as fh:
                tree = ast.parse(fh.read(), filename=f)
        except SyntaxError as e:
            fail(f, 'SyntaxError: ' + str(e))
            continue
        found = []
        collect(tree, False, found)
        for line, level, module, optional in found:
            if optional:
                continue
            where = f + ':' + str(line)
            if level > 0:
                if not relative_exists(level, module, f):
                    fail(where, "ModuleNotFoundError: No module named '" + '.' * level + (module or '') + "' (imported from " + f + ')')
            elif not module_exists(module.split('.')[0], f):
                fail(where, "ModuleNotFoundError: No module named '" + module.split('.')[0] + "' (imported from " + f + ')')
            elif '.' in module and dotted_status(module, f) == 'missing':
                fail(where, "ModuleNotFoundError: No module named '" + module + "' (imported from " + f + ')')


def block_network():
    import socket

    def refuse(*args, **kwargs):
        raise OSError('qsr-check-exports: the network is blocked while packages are loaded')

    socket.socket.connect = refuse
    socket.socket.connect_ex = refuse
    socket.getaddrinfo = refuse
    socket.create_connection = refuse


def check_exports():
    # exports (experimental, off unless the executor is asked for it): for every static "from pkg import name" of an
    # installed top-level package, import the package once (this runs its module body, so the network is blocked in-process)
    # and check that it has the name, as an attribute or as a submodule. Nothing the package defines is called. A package
    # that cannot be imported here is reported as unchecked, never as a failure of the docs.
    block_network()
    loaded = {}
    unchecked = []
    for f in files:
        if not os.path.isfile(f):
            continue
        try:
            with open(f, encoding='utf-8') as fh:
                tree = ast.parse(fh.read(), filename=f)
        except SyntaxError:
            continue
        found = []
        collect(tree, False, found)
        sites = []

        def visit(node, optional):
            if isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
                sites.append((node.lineno, node.module, [a.name for a in node.names if a.name != '*'], optional))
            elif isinstance(node, ast.Import):
                # 'import pkg.sub': only the dotted forms matter here (a plain 'import pkg' is the imports check job)
                sites.extend((node.lineno, a.name, [], optional) for a in node.names if '.' in a.name)
            if isinstance(node, TRY_NODES):
                covered = optional or handlers_catch_import_errors(node.handlers)
                for s in node.body:
                    visit(s, covered)
                for h in node.handlers:
                    visit(h, optional)
                for s in node.orelse + node.finalbody:
                    visit(s, optional)
            else:
                for child in ast.iter_child_nodes(node):
                    visit(child, optional)

        visit(tree, False)
        for line, module, names, optional in sites:
            top = module.split('.')[0]
            if optional or not module_exists(top, f):
                continue
            if module not in loaded:
                saved = list(sys.path)
                sys.path[:0] = [os.path.dirname(os.path.abspath(f)), cwd]
                try:
                    loaded[module] = importlib.import_module(module)
                except BaseException as error:
                    loaded[module] = None
                    missing = getattr(error, 'name', None)
                    if isinstance(error, ModuleNotFoundError) and missing and (module == missing or module.startswith(missing + '.')):
                        # the package is installed, but the module the docs import from it is not in it
                        fail(f + ':' + str(line), "qsr-check-exports: cannot import module '" + module + "' (" + str(error) + ") (imported from " + f + ')')
                    else:
                        unchecked.append(module + ' (' + type(error).__name__ + ': ' + str(error).split(chr(10))[0] + ')')
                finally:
                    sys.path[:] = saved
            mod = loaded[module]
            if mod is None:
                continue
            for name in names:
                if hasattr(mod, name):
                    continue
                try:
                    if importlib.util.find_spec(module + '.' + name) is not None:
                        continue
                except (ImportError, ValueError, AttributeError):
                    pass
                fail(f + ':' + str(line), "qsr-check-exports: cannot import name '" + name + "' from '" + module + "' (imported from " + f + ')')
    if unchecked:
        print('qsr-check-exports: not checked, the package could not be imported here: ' + '; '.join(sorted(set(unchecked))))


try:
    if mode == 'syntax':
        check_syntax()
    elif mode == 'imports':
        check_imports()
    elif mode == 'exports':
        check_exports()
    else:
        raise ValueError('unknown mode ' + mode)
except Exception:
    sys.stderr.write('qsr: harness check crashed: ' + traceback.format_exc())
    sys.exit(2)
if problems:
    sys.stderr.write('\n'.join(problems) + '\n')
    sys.exit(1)
print('ok ' + mode + ' ' + ' '.join(files))
`;
