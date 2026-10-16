# @qsr/compiler

Turns a crawled docs page (`Extraction`) into a Step IR plan with Groq, and a deterministic **grounding validator** rejects anything the docs did not say (spec section 8). The model decides order and structure. It never writes code.

Pure library: no HTTP server, no database. The model and the plan cache are injected.

## Public API

```ts
import { compile, createFileCache, createGroqClient, resolveConfig } from '@qsr/compiler';

const config = resolveConfig(); // model name lives here, not in the logic
const result = await compile(target, extraction, {
  llm: createGroqClient({ apiKey: process.env.GROQ_API_KEY!, config }),
  cache: createFileCache('.qsr-cache'), // the API passes a table-backed cache in phase P6
  config,
  log, // any pino-style logger
});

result.plan.accepted; // false => COMPILER_ERROR (our failure, never shown as the vendor's)
result.plan.ir; // StepIR, or null when rejected
result.plan.groundingReport; // { ok, violations: [{ stepId, rule, detail }] }
result.fromCache; // true => zero model calls
result.llmCalls; // one record per call, shaped for the llm_calls table
```

CLI: `pnpm qsr compile <slug>` (flags `--json`, `--refresh`, `--cache-dir`). Needs `GROQ_API_KEY` only on a cache miss.

## Pipeline

1. **Cache** lookup by `(tool, contentHash, COMPILER_VERSION)`. A hit makes zero model calls. Rejected plans are cached too, so a broken page does not hammer the model every cycle.
2. **Prompt** (`prompt.ts`): system rules plus `TARGET` plus `DOCS_DATA`, the page as JSON. Page text is data, never instructions: every string is JSON-escaped, the data section is flagged untrusted, and the last line of the message is a trusted instruction.
3. **One model call**: JSON mode, temperature 0, 4096 output tokens max. At most **one retry after a schema error** (the Zod error is appended) and **one after a grounding failure** (the violations are listed), so at most 3 calls.
4. **Deterministic passes** on what comes back, in this order:
   1. `quarantineDestructive`: a denylisted step (`sudo`, `rm -rf /`, `mkfs`, `shutdown`, fork bombs, writes outside `/work`) becomes a `manual` step, even if the docs say it verbatim.
   2. `quarantineInteractive`: an interactive scaffolder (`npm create hono@latest`) becomes a `manual` step, the plan stops there, and the note says why.
   3. `fillFileContent`: **file content is copied from the cited lines**, not from the model (see below).
   4. `finalizePlan`: harness-owned fields are set by us: exit code 0, no output assertions, auth-error-as-pass only for `run` steps of level 3+ targets that ask for it, timeouts capped by the target, `maxLevelReachable` capped at the target level, `projectInit` per language.
5. **`validateGrounding`** decides. Failing twice stores the plan with `accepted = false`, `ir = null`.

Model or network failures throw `LlmError` and are **not** cached.

## Long pages (`select.ts`)

A page longer than the budget is **never silently treated as complete**.

1. **Selection** (`selectBlocks`, deterministic): blocks are ranked in _units_, a code block together with the up to 2 prose blocks right before it. Units whose section heading looks like a quickstart (`/quick ?start|getting started|install|setup|usage|hello world/i`, matched after removing the heading path every block shares, so a page titled "Getting Started" does not make everything a quickstart) come first; within a group the document order decides, so the top of a page beats its tail. Then prose that introduces no code, then headings (their text is already in every block's `heading` field). Blocks are taken in that order while they fit and sent **in document order**, never reordered. A block that does not fit is omitted whole. Only when the single most important block does not fit even alone is it clipped from the top and marked `"clipped": true`.
2. **Recorded**: `plan.truncation = { truncated, totalBlocks, includedBlocks, omittedBlocks, omittedBlockIndexes, clippedBlockIndexes }`, built from the selection, never from the model, and cached with the plan. `qsr compile` prints it (`page: TRUNCATED, N of M blocks not shown to the model`).
3. **Told to the model**: the data carries the same `truncation` object and the system prompt (INCOMPLETE DATA) says omitted blocks exist, that it must not invent or assume steps for them, and to say so in `notes`.
4. **Level cap**: `finalizePlan` caps `maxLevelReachable` at 2 for a truncated page unless the plan itself contains an install, a file write and a run step.

Changing how blocks are selected changes what the model sees: bump `COMPILER_VERSION` for it, as for a prompt change.

## The grounding validator (`grounding/`)

100% statement, branch, function and line coverage is enforced (`pnpm --filter @qsr/compiler test`). Rule ids:

| Rule                                                                             | Meaning                                                                                  |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `source.block_not_found` / `range_invalid` / `not_code`                          | The citation does not exist, or points at prose for a command or file                    |
| `command.mismatch`                                                               | Not the cited lines or a whole `&&` / `;` / `\|\|` sub-command of them (quote-aware)     |
| `command.source_not_shell` / `command.empty`                                     | Cited a JSON/TypeScript/... block as a command, or an empty command                      |
| `file.content_mismatch`                                                          | Content differs from the cited lines; the message names the first differing line         |
| `file.path_invalid` / `file.path_ungrounded`                                     | Malformed path, or a name the docs never gave (hint, prose, first-line comment, default) |
| `env.name_invalid` / `name_protected` / `not_grounded` / `value_not_placeholder` | `set_env` rules; protected names such as `PATH`, `LD_PRELOAD`, `NODE_OPTIONS`            |
| `run.not_allowlisted` / `run.file_not_written`                                   | Unsourced `run` must be `node`, `npx tsx` or `python` on a file an earlier step wrote    |
| `text.suspicious_characters`                                                     | Zero-width, bidi-control or other hidden characters anywhere in the plan                 |
| `denylist`                                                                       | Destructive command or write outside `/work`                                             |
| `plan.duplicate_step_id` / `plan.language_mismatch`                              | Plan-level consistency                                                                   |

Comparison is exact code point by code point: there is no Unicode normalization, so look-alikes cannot be folded into the ASCII the docs contain.

## Decisions, and the evidence behind them

- **Model**: the spec's `llama-3.3-70b-versatile` is no longer served on the project's Groq account. The default is `openai/gpt-oss-120b` with `reasoning_effort: low` (reasoning tokens count inside the output cap). The model name is configuration (`config.ts`, `QSR_COMPILER_MODEL`).
- **File content is copied, not generated.** Measured on the Pydantic page: asked to reproduce a 33-line file, the model dropped a single trailing comma in 2 of 5 runs, and the retry repeated it. The validator was right to reject it, but the failure class is avoidable: the model now cites lines and the harness copies them. Output tokens fell from up to 1,054 to 233-459 per plan, and the validator still checks the result against the citation.
- **Stricter than the spec on file content**: indentation is compared exactly (only trailing whitespace and blank-line runs are normalized), because indentation is program text in Python and YAML.
- **Groq free tier**: a request is rejected above 8,000 prompt tokens (`HTTP 413`), and 429s carry a `Retry-After`. The `max_tokens` reservation does not count. The docs budget is `maxDocsChars` (10,000 characters, about 2.9 characters per token); blocks over it are left out by priority and recorded (see "Long pages" below). The client retries 429/5xx four times, honouring `Retry-After` up to 60 s, and keeps the provider's explanation in the error.
- **Non-determinism**: the same page compiled differently across runs at temperature 0. Rather than trusting the model, everything that can be decided deterministically is.

## Versioning rule

`COMPILER_VERSION` is part of the cache key. Bump it whenever **anything that changes a plan's output** changes: the system prompt (a test pins its hash and fails with instructions), or any step in the pipeline above. Otherwise old plans keep being served.

Known limitation: the cache key (spec section 8) does not include the target file. If you change a target's `placeholders` without the docs changing, run `qsr compile <slug> --refresh`.

## Testing

`pnpm --filter @qsr/compiler test` runs 367 tests with the coverage gate: adversarial validator tests (9 attack classes), denylist and interactive-scaffolder tables, cache and Groq client contracts, the compile flow (retries, caching, injection), and golden tests that run the real crawler on the fixture docs with a mocked model reply. The golden tests need Chromium (`pnpm --filter @qsr/crawler exec playwright install chromium`).
