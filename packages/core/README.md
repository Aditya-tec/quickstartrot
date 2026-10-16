# @qsr/core

Zod schemas and shared types: the single source of truth for Step IR, targets, extractions, run payloads and the failure taxonomy (spec sections 5 to 9).

## Public API

```ts
import { Target, StepIR, RunResult, Extraction, FAILURE_CLASSES } from '@qsr/core';

const target = Target.parse(yamlObject); // applies defaults, throws ZodError on bad input
const ir = StepIR.safeParse(llmJson); // never trust LLM output without parsing
```

| Export                                          | Spec section | Purpose                                         |
| ----------------------------------------------- | ------------ | ----------------------------------------------- |
| `ToolStatus`, `RunOutcome`, `FailureClass`, ... | 5            | Enums shared with the database                  |
| `Target`                                        | 6            | One `targets/<slug>.yaml` file                  |
| `Extraction`, `ExtractionBlock`                 | 7            | Crawler output                                  |
| `Step`, `StepIR`, `SourceRef`, `Expect`         | 8            | The typed plan the compiler produces            |
| `GroundingReport`                               | 8            | Output of the deterministic grounding validator |
| `RunResult`, `StepResult`                       | 9            | Executor output contract                        |

`RunResult` is exactly the spec section 9 shape. The version-drift capture of section 10 (`runner_env.resolved`) is stored inside `runnerEnv` as a JSON string under `RUNNER_ENV_KEYS.resolved`; `parseResolved(runnerEnv)` reads it back.

`redact(text, { secrets })` is the one place secrets are removed from captured output (spec sections 4 and 9): dummy keys, secret-looking tokens, the runner's home path and IP addresses, with ANSI stripped.
