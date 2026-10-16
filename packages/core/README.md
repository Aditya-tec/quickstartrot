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

`RunResult.resolved` carries the resolved top-level package versions (spec section 10, version drift capture); the API stores it as `runner_env.resolved`.
