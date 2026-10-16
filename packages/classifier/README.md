# @qsr/classifier

Turns a failed run into a **class**, a **rule id**, a **signature** and an **evidence line** (spec section 10). Pure library: no HTTP, no database, no Docker. The LLM is injected and used only as a fallback.

## Public API

```ts
import { classify, classifyWithFallback, inputFromRunResult } from '@qsr/classifier';

// RunResult (spec section 9) + what the target file says -> the classifier's input (null for a PASS)
const input = inputFromRunResult(runResult, {
  language: 'node',
  targetLevel: 3,
  authErrorIsPass: false, // the failing step's: target.expect.authErrorIsPass, level >= 3, a run step
  logs: { s3: fullRedactedLogText }, // optional; the stored 4 KB tails are used otherwise
});

classify(input); // rules only -> Classification | null (null: no rule matched)
await classifyWithFallback(input, { llm }); // rules, then the injected model, else UNKNOWN. Never throws.
```

```ts
interface Classification {
  failureClass: FailureClass; // the spec taxonomy
  ruleId: string; // 'drift.not_a_function', 'llm.fallback', 'none'
  evidenceLine: string | null;
  signature: string; // sha256, see below
  source: 'rule' | 'llm' | 'none';
  confidence: number | null; // LLM answers only
}
```

CLI: `pnpm qsr classify <run-result.json>` (`--json`, `--llm`, `--targets <dir>`). It reads the step logs next to the file, as `qsr run --out` writes them, and the level and `authErrorIsPass` from the target file.

## Rules (`src/rules.ts`)

An ordered table: **first match wins**, so the order is the behaviour. Each rule has a stable id (stored on the run as `classifier_rule`; never rename one), a class, a description, and either a `pattern` over the step's text or a `when` over facts. **Every rule has at least one fixture** and a test fails if one does not.

| Order | Rule ids                                                                                                                                     | Class                   | Why it sits there                                                                                                       |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 1     | `harness.run_outcome`                                                                                                                        | `HARNESS_ERROR`         | the executor says so; nothing in the log can overrule it                                                                |
| 2     | `skipped.manual_step`                                                                                                                        | `NEEDS_CREDENTIALS`     | plan stopped at a manual step before the target level                                                                   |
| 3     | `timeout.exit_124`, `timeout.killed_note`                                                                                                    | `TIMEOUT`               | exit 124 (or the executor's note, for an exit 137 after `timeout -k`) beats any text                                    |
| 4     | `check.*`                                                                                                                                    | see below               | the harness's own wording; only for `harness_check` steps                                                               |
| 5     | `runtime.npm_ebadengine`, `runtime.python_requires`, `runtime.python_ignored_versions`                                                       | `RUNTIME_VERSION`       | error-level lines only: EBADENGINE is usually just an npm _warning_                                                     |
| 6     | `dependency.npm_e404`, `_etarget`, `_eresolve`                                                                                               | `DEPENDENCY_RESOLUTION` | explicit npm error codes beat network text: npm prints retry warnings, then a real 404                                  |
| 7     | `network.npm_code`, `network.connection`, `network.dns`, `network.registry_5xx`, `network.pip_connection`                                    | `NETWORK_TRANSIENT`     | before pip's dependency rules: a failed connection ends in the same "No matching distribution found"                    |
| 8     | `dependency.pip_resolution_impossible`, `dependency.pip_no_matching`                                                                         | `DEPENDENCY_RESOLUTION` |                                                                                                                         |
| 9     | `drift.no_export`                                                                                                                            | `API_DRIFT`             | Node reports "does not provide an export named" as a `SyntaxError`; this must win over the next rule                    |
| 10    | `docs.syntax_error`, `docs.indentation`, `docs.undefined_name`, `docs.typescript`                                                            | `DOCS_SNIPPET_ERROR`    |                                                                                                                         |
| 11    | `drift.not_a_function`, `_not_a_constructor`, `_python_import_name`, `_python_attribute`, `_unexpected_argument`, `import.missing_submodule` | `API_DRIFT`             |                                                                                                                         |
| 12    | `import.missing_relative`, `import.missing_package`                                                                                          | `DOCS_SNIPPET_ERROR`    | the docs import something no step writes or installs                                                                    |
| 13    | `credentials.auth_error`                                                                                                                     | `NEEDS_CREDENTIALS`     | **last**: an import error printed after a 401 is drift, not credentials; `run` steps only; never when `authErrorIsPass` |

npm 10 prints `npm error`, not `npm ERR!`; every npm rule matches both.

### Harness-check failures: the mapping

The checks (`@qsr/executor`) fail with text the classifier knows; the class says whose fault the broken import is.

| Check finds                                                 | Rule                                          | Class                | Reasoning                             |
| ----------------------------------------------------------- | --------------------------------------------- | -------------------- | ------------------------------------- |
| a syntax error in the docs' code                            | `check.syntax`                                | `DOCS_SNIPPET_ERROR` | the code does not parse               |
| `require()` in an ES module, or an extensionless ESM import | `check.require_in_esm`, `check.esm_extension` | `DOCS_SNIPPET_ERROR` | the snippet contradicts itself        |
| an import of a package no step installs (Node and Python)   | `check.package_not_installed`                 | `DOCS_SNIPPET_ERROR` | the docs forgot an install            |
| a relative import of a file no step writes                  | `check.relative_missing`                      | `DOCS_SNIPPET_ERROR` | the docs forgot a file                |
| a subpath the **installed** package no longer exports       | `check.subpath_not_exported`                  | `API_DRIFT`          | the vendor changed its package layout |
| a file inside the **installed** package that is gone        | `check.deep_import_missing`                   | `API_DRIFT`          | same                                  |

The same split applies to run-time `Cannot find module` / `No module named`: a top-level name is `DOCS_SNIPPET_ERROR` (`import.missing_package`), a path or dotted name inside an installed package is `API_DRIFT` (`import.missing_submodule`).

## Signature (`src/signature.ts`)

`sha256(class + stepKind + normalize(firstErrorLines))`, with NUL separators. `firstErrorLines` are up to 3 lines matching an error pattern in the failing step's output (stack frames, `Traceback`, and npm's "complete log" pointer are skipped). `normalize` removes ANSI codes, absolute paths (Unix, Windows, `~/`), `:line:col`, TypeScript's `(line,col)`, Python's `, line N`, hex addresses, timestamps (including npm's `2026-10-16T07_51_26_705Z`), durations, temp dir names and uuids, then lowercases. **Package names and identifiers are kept**: `createClient is not a function` and `sendEmail is not a function` are different failures, and so is a path inside `node_modules/` (its package part survives).

## LLM fallback (`src/fallback.ts`)

Only when no rule matches a **FAIL** and there is output to read. The client is injected (`ClassifierLlm`; `LlmClient` from `@qsr/compiler` fits). The model gets the failing command and the last 60 lines of the step's output (stdout and stderr interleaved, as in the log), between delimiters chosen so they cannot occur in the log, with a system message that calls the output untrusted. Its answer is accepted only if all of these hold, else the result is `UNKNOWN`:

- it is JSON of the shape `{ class, confidence, evidenceLine }`, with `class` one of the seven classes a step log can justify (never `HARNESS_ERROR`, `CRAWL_ERROR`, `COMPILER_ERROR` or `UNKNOWN`);
- `confidence >= 0.7`;
- `evidenceLine` (at least 6 characters) appears **verbatim** in the lines the model was shown.

An accepted answer has `source: 'llm'` and rule id `llm.fallback`; the API lists every one in the admin queue so a rule can be added (the fixture comes first).

## Fixtures (`fixtures/`)

One JSON file per case: a `RunResult`, the full step logs, the target facts and the expected class and rule. **Captured** fixtures come from real runs in the sandbox images (`node scripts/capture-classifier-fixtures.mjs`, needs Docker and the network); `synthetic-*` fixtures are hand-written for failures that cannot be produced on demand (ECONNRESET, registry 5xx, a process killed after its time limit). Real logs corrected two assumptions while this was written: pip ignores an `http://` index instead of failing to connect, and with `--retries 0` pip prints nothing about a refused connection at all.

## Testing

`pnpm --filter @qsr/classifier test` runs with a **100% coverage gate** (statements, branches, functions, lines).
