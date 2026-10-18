import { ALL_AUTH_PATTERNS, type FailureClass } from '@qsr/core';
import type { ClassifyInput } from './types.js';

// Spec section 10: "rules run first, first match wins, each rule has an id stored on the run".
// This table IS the behaviour: its ORDER decides every ambiguous log, and each rule has a fixture
// (packages/classifier/fixtures) that proves it. To add a rule, add the fixture first.
//
// Why the order is what it is (each line is covered by a precedence test):
//   context facts (harness error, manual stop, exit 124) come before any text;
//   harness_check output is the harness's own wording, so those rules apply only to that step kind;
//   explicit npm error CODES (E404, ETARGET, ERESOLVE) come before network text, because npm prints
//     retry warnings for a registry that then answers with a real 404;
//   network text comes before pip's "No matching distribution", because pip ends a failed connection
//     with the same words it uses for a package that does not exist;
//   "does not provide an export named" comes before the generic SyntaxError that Node files it under;
//   drift and import errors come before auth errors, so "401 ... then ImportError" is drift, not credentials.

interface RuleBase {
  /** Stable id stored on the run (`runs.classifier_rule`). Never reuse or rename one. */
  id: string;
  failureClass: FailureClass;
  description: string;
  /** Step kinds the rule applies to. Omitted: any. */
  stepKinds?: readonly string[];
  /** An extra condition, checked before the rule is evaluated. */
  guard?: (input: ClassifyInput) => boolean;
}

/** Matched against the failing step's text; the first line that matches is the evidence. */
interface PatternRule extends RuleBase {
  pattern: RegExp;
  when?: never;
}

/** Decides from facts instead of text; returns the evidence, or null when it does not apply. */
interface FactRule extends RuleBase {
  when: (input: ClassifyInput) => string | null;
  pattern?: never;
}

export type Rule = PatternRule | FactRule;

const CHECK = ['harness_check'] as const;

/** An auth error in a `run` step is the reason it failed only when auth errors are not a pass. */
const authIsFailure = (input: ClassifyInput): boolean => !input.run.authErrorIsPass;

export const RULES: readonly Rule[] = [
  // ---- facts about the run
  {
    id: 'harness.run_outcome',
    failureClass: 'HARNESS_ERROR',
    description:
      "The run ended in a harness error: Docker, a bad path or an executor exception. Ours, never the vendor's.",
    when: ({ run, step }) =>
      run.outcome === 'HARNESS_ERROR'
        ? (firstLine(step, /harness error/i) ?? 'the run ended in a harness error')
        : null,
  },
  {
    id: 'skipped.manual_step',
    failureClass: 'NEEDS_CREDENTIALS',
    description:
      'The plan stopped at a manual step before the target level (sign-up, a key from a dashboard).',
    when: ({ run }) =>
      run.outcome === 'SKIPPED' && run.skipReason === 'manual_step'
        ? `plan stopped at a manual step at L${run.reachedLevel} before the target's L${run.targetLevel}`
        : null,
  },
  {
    id: 'timeout.exit_124',
    failureClass: 'TIMEOUT',
    description: 'Exit code 124 from `timeout`: the step hit its time limit.',
    when: ({ step }) => (step?.exitCode === 124 ? 'exit code 124 from timeout' : null),
  },
  {
    id: 'timeout.killed_note',
    failureClass: 'TIMEOUT',
    description:
      'The executor noted the step timed out and was killed (exit 137 after `timeout -k`, or no exit code).',
    pattern: /\[qsr\] (?:step timed out after|the run exceeded its overall time limit)/,
  },

  // ---- the harness's own checks (L2): what they find in the docs' code
  {
    id: 'check.subpath_not_exported',
    failureClass: 'API_DRIFT',
    description:
      'The package is installed but its export map no longer offers the path the docs import.',
    stepKinds: CHECK,
    pattern: /is not defined by "exports"/,
  },
  {
    id: 'check.deep_import_missing',
    failureClass: 'API_DRIFT',
    description: 'The package is installed but the file the docs import from inside it is gone.',
    stepKinds: CHECK,
    pattern: /Cannot find module '[^']*node_modules[\\/][^']+'/,
  },
  {
    id: 'check.export_missing',
    failureClass: 'API_DRIFT',
    description:
      'The package is installed but no longer exports a name the docs import (found by the experimental qsr-check-exports, which is off unless asked for).',
    stepKinds: CHECK,
    pattern: /qsr-check-exports: (?:'[^']+' does not export '|cannot import (?:name|module) ')/,
  },
  {
    id: 'check.syntax',
    failureClass: 'DOCS_SNIPPET_ERROR',
    description: "The docs' code does not parse.",
    stepKinds: CHECK,
    pattern: /\bSyntaxError\b/,
  },
  {
    id: 'check.require_in_esm',
    failureClass: 'DOCS_SNIPPET_ERROR',
    description: 'The docs use require() in a file that is an ES module.',
    stepKinds: CHECK,
    pattern: /require is not defined in ES module scope/,
  },
  {
    id: 'check.esm_extension',
    failureClass: 'DOCS_SNIPPET_ERROR',
    description: 'The docs import a relative file in an ES module without its extension.',
    stepKinds: CHECK,
    pattern: /ES modules need the full file name/,
  },
  {
    id: 'check.python_submodule_missing',
    failureClass: 'API_DRIFT',
    description:
      'Python: the package is installed but a module path inside it that the docs import is gone (harness version 2 resolves the full dotted path). The same class as a Node deep import, check.deep_import_missing.',
    stepKinds: CHECK,
    pattern: /No module named '[^'.]+(?:\.[^'.]+)+'/,
  },
  {
    id: 'check.package_not_installed',
    failureClass: 'DOCS_SNIPPET_ERROR',
    description: "The docs' code imports a package that no step of the docs installs.",
    stepKinds: CHECK,
    pattern: /Cannot find package '|No module named '[^'.]/,
  },
  {
    id: 'check.relative_missing',
    failureClass: 'DOCS_SNIPPET_ERROR',
    description: "The docs' code imports a local file that no step of the docs writes.",
    stepKinds: CHECK,
    pattern: /Cannot find module '\.|No module named '\./,
  },

  // ---- runtime version
  {
    id: 'runtime.npm_ebadengine',
    failureClass: 'RUNTIME_VERSION',
    description:
      'npm refused the install: the package does not support this Node version (an error, not the usual warning).',
    pattern: /npm (?:error|ERR!) code EBADENGINE/,
  },
  {
    id: 'runtime.python_requires',
    failureClass: 'RUNTIME_VERSION',
    description: 'pip refused the install: the package requires a different Python.',
    pattern: /Package '[^']*' requires a different Python/,
  },
  {
    id: 'runtime.python_ignored_versions',
    failureClass: 'RUNTIME_VERSION',
    description:
      'pip skipped every release because they require a different Python, then found nothing to install.',
    pattern: /Ignored the following versions that require a different Python version/,
  },

  // ---- dependency resolution: explicit npm error codes first
  {
    id: 'dependency.npm_e404',
    failureClass: 'DEPENDENCY_RESOLUTION',
    description: 'npm: the package is not in the registry (E404).',
    pattern: /npm (?:error|ERR!) (?:code E404\b|404\b)/,
  },
  {
    id: 'dependency.npm_etarget',
    failureClass: 'DEPENDENCY_RESOLUTION',
    description: 'npm: no version matches the requested range (ETARGET / notarget).',
    pattern: /npm (?:error|ERR!) (?:code ETARGET\b|notarget)/,
  },
  {
    id: 'dependency.npm_resolver_crash',
    failureClass: 'DEPENDENCY_RESOLUTION',
    description:
      "npm's own dependency-tree builder crashed (Cannot read properties of null, reading 'edgesOut'): the install could not be resolved. It is npm failing rather than a named package, so a person reviews it before it is public like any vendor failure.",
    pattern: /npm (?:error|ERR!) Cannot read properties of null \(reading 'edgesOut'\)/,
  },
  {
    id: 'dependency.npm_eresolve',
    failureClass: 'DEPENDENCY_RESOLUTION',
    description: 'npm: the dependency tree cannot be resolved (ERESOLVE, peer conflicts).',
    pattern: /npm (?:error|ERR!) (?:code ERESOLVE\b|ERESOLVE )/,
  },

  // ---- network: before pip's dependency wording, which a failed connection also produces
  {
    id: 'network.npm_code',
    failureClass: 'NETWORK_TRANSIENT',
    description:
      'npm failed with a network error code (reset, timeout, DNS, refused, registry 5xx).',
    pattern:
      /npm (?:error|ERR!) code (?:ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|ESOCKETTIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|E50[0-4])\b/,
  },
  {
    id: 'network.connection',
    failureClass: 'NETWORK_TRANSIENT',
    description: 'A connection was reset, refused or timed out.',
    pattern:
      /\b(?:ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|ESOCKETTIMEDOUT)\b|socket hang up|ReadTimeoutError|ConnectionResetError|Read timed out|Connection timed out/i,
  },
  {
    id: 'network.dns',
    failureClass: 'NETWORK_TRANSIENT',
    description: 'A host name did not resolve.',
    pattern:
      /\bEAI_AGAIN\b|\bENOTFOUND\b|Temporary failure in name resolution|Name or service not known|\bgetaddrinfo\b/,
  },
  {
    id: 'network.registry_5xx',
    failureClass: 'NETWORK_TRANSIENT',
    description: 'The package registry answered with a server error (500, 502, 503, 504).',
    pattern:
      /\bE50[0234]\b|\b50[0234] (?:Internal Server Error|Bad Gateway|Service Unavailable|Gateway Time-?out)|HTTP error 50[0234]/i,
  },
  {
    id: 'network.pip_connection',
    failureClass: 'NETWORK_TRANSIENT',
    description: 'pip could not connect to the index (retry warnings).',
    pattern:
      /Failed to establish a new connection|NewConnectionError|Max retries exceeded|Retrying \(Retry\(/,
  },

  // ---- dependency resolution: pip
  {
    id: 'dependency.pip_resolution_impossible',
    failureClass: 'DEPENDENCY_RESOLUTION',
    description: 'pip: the requirements conflict (ResolutionImpossible).',
    pattern: /ResolutionImpossible/,
  },
  {
    id: 'dependency.pip_no_matching',
    failureClass: 'DEPENDENCY_RESOLUTION',
    description: 'pip: no distribution matches the requirement.',
    pattern:
      /No matching distribution found|Could not find a version that satisfies the requirement/,
  },

  // ---- the docs' code itself
  {
    id: 'drift.no_export',
    failureClass: 'API_DRIFT',
    description:
      'The module no longer exports a name the docs import (Node reports it as a SyntaxError).',
    pattern:
      /does not provide an export named|has no exported member|ERR_PACKAGE_PATH_NOT_EXPORTED|Named export '[^']*' not found/,
  },
  {
    id: 'docs.syntax_error',
    failureClass: 'DOCS_SNIPPET_ERROR',
    description: 'A SyntaxError at run time.',
    pattern: /\bSyntaxError\b/,
  },
  {
    id: 'docs.indentation',
    failureClass: 'DOCS_SNIPPET_ERROR',
    description: 'Python IndentationError or TabError.',
    pattern: /\b(?:IndentationError|TabError)\b/,
  },
  {
    id: 'docs.undefined_name',
    failureClass: 'DOCS_SNIPPET_ERROR',
    description: "The docs' code uses a name it never defines (ReferenceError, NameError).",
    pattern: /ReferenceError: [\w$.]+ is not defined|NameError: name '[^']*' is not defined/,
  },
  {
    id: 'docs.typescript',
    failureClass: 'DOCS_SNIPPET_ERROR',
    description:
      "The TypeScript compiler rejects the docs' code (TS2304, TS2307, or a syntax code).",
    pattern: /error TS(?:2304|2307|1\d{3})\b/,
  },
  {
    id: 'drift.not_a_function',
    failureClass: 'API_DRIFT',
    description: 'The docs call something the SDK no longer has (TypeError: x is not a function).',
    pattern: /is not a function/,
  },
  {
    id: 'drift.not_a_constructor',
    failureClass: 'API_DRIFT',
    description:
      'The docs construct something the SDK no longer has (TypeError: x is not a constructor).',
    pattern: /is not a constructor/,
  },
  {
    id: 'drift.python_import_name',
    failureClass: 'API_DRIFT',
    description:
      'Python: the name the docs import is gone from the module (ImportError: cannot import name).',
    pattern: /ImportError: cannot import name/,
  },
  {
    id: 'drift.python_attribute',
    failureClass: 'API_DRIFT',
    description: 'Python: the module or object the docs use no longer has that attribute.',
    pattern: /AttributeError: (?:module|type object|'[^']+' object) /,
  },
  {
    id: 'drift.unexpected_argument',
    failureClass: 'API_DRIFT',
    description:
      'The docs pass arguments the function no longer accepts (or omit new required ones).',
    pattern:
      /unexpected keyword argument|missing \d+ required (?:positional|keyword-only) arguments?|takes \d+ positional arguments? but \d+ (?:was|were) given/,
  },
  {
    id: 'import.missing_submodule',
    failureClass: 'API_DRIFT',
    description: 'A file or submodule inside an installed package is gone.',
    pattern:
      /Cannot find module '(?:(?:@[\w.-]+\/[\w.-]+|\w[\w.-]*)\/[^']+|[^']*node_modules[\\/][^']+)'|ModuleNotFoundError: No module named '[^'.]+\.[^']+'/,
  },
  {
    id: 'import.missing_relative',
    failureClass: 'DOCS_SNIPPET_ERROR',
    description: 'The docs import a local file that no step writes.',
    pattern: /Cannot find module '\.{1,2}\//,
  },
  {
    id: 'import.missing_package',
    failureClass: 'DOCS_SNIPPET_ERROR',
    description: 'The docs import a package that no step installs.',
    pattern:
      /Cannot find (?:module|package) '(?:@[\w.-]+\/[\w.-]+|\w[\w.-]*)'|ModuleNotFoundError: No module named '\w+'/,
  },

  // ---- credentials: last, so any real error above wins over an auth line printed earlier
  {
    id: 'credentials.auth_error',
    failureClass: 'NEEDS_CREDENTIALS',
    description:
      'The quickstart code was refused for lack of credentials, and auth errors are not a pass for this step.',
    stepKinds: ['run'],
    guard: authIsFailure,
    when: ({ step }) => firstAuthLine(textOf(step)),
  },
];

// ---------------------------------------------------------------------------------------------

/** The text a rule reads: the full log when there is one (and it is not empty), else the tails (stderr first). */
export function textOf(step: ClassifyInput['step']): string {
  if (!step) return '';
  if (step.log) return step.log;
  return [step.stderrTail, step.stdoutTail]
    .filter((t): t is string => t !== null && t !== '')
    .join('\n');
}

export const EVIDENCE_MAX = 300;

/** First line of the step's text matching `re`, trimmed and capped. */
export function firstLine(step: ClassifyInput['step'], re: RegExp): string | null {
  for (const line of textOf(step).split(/\r?\n/))
    if (re.test(line)) return line.trim().slice(0, EVIDENCE_MAX);
  return null;
}

function firstAuthLine(text: string): string | null {
  for (const line of text.split(/\r?\n/))
    if (ALL_AUTH_PATTERNS.some((p) => p.re.test(line))) return line.trim().slice(0, EVIDENCE_MAX);
  return null;
}
