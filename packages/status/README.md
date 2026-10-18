# @qsr/status

The status engine and incident state machine (spec section 10): one pure function. No I/O, no clock (time is `run.finishedAt`), no database. The API loads the tool row and its incidents, calls it once per run at cycle finish, and applies the result in one transaction.

## Public API

```ts
import { evaluate } from '@qsr/status';

const { next, events } = evaluate(state, run, ctx);
```

Types are in `@qsr/core` (`status.ts`):

| Input                | Fields                                                                                                                                                                                                         |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `state: ToolState`   | `status`, `statusSince`, `consecutiveFailures`, `consecutivePasses`, `transientStreak`, `lastFailureSignature`, `lastFailureClass` (the `tools` row; migration `0002_tool_state_columns` added the last three) |
| `run: StatusRun`     | `outcome`, `failureClass`, `failureSignature` (from `@qsr/classifier`), `reachedLevel`, `skipReason`, `finishedAt`                                                                                             |
| `ctx: StatusContext` | `cycleValid`, `openIncident` (`{ id, signature, failureClass }` or null), `recentlyResolvedIncidents` (`{ id, signature, resolvedAt }`), `previousReachedLevel`                                                |

| Output event                 | The API should                                                                                      |
| ---------------------------- | --------------------------------------------------------------------------------------------------- |
| `incident_opened`            | insert an incident, `PENDING_REVIEW` (`trigger`: `repeat_failure`, `transient_streak`, or `repair`) |
| `incident_resolved`          | resolve the open incident                                                                           |
| `incident_signature_changed` | add a `signature_changed` event to the open incident                                                |
| `incident_recurred`          | reopen that incident and add a `recurred` event                                                     |
| `admin_queue`                | add an admin queue item; never an incident (`reason` says why)                                      |
| `cycle_ignored`              | note that the cycle was invalid; nothing else was applied                                           |

`next` is always a new object; the inputs are never mutated.

## The transition table

Each spec row has a `describe` block in `src/evaluate.test.ts` named after it.

| Row | From              | Run                                                                                     | Guard                                  | To                                                                               | Event                                            |
| --- | ----------------- | --------------------------------------------------------------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------ |
| 1   | any               | PASS                                                                                    |                                        | HEALTHY once `consecutivePasses` is 2; **immediately** from UNKNOWN and DEGRADED | resolve the open incident, if any                |
| 2   | HEALTHY / UNKNOWN | FAIL, vendor class                                                                      | first failure                          | DEGRADED                                                                         |                                                  |
| 3   | DEGRADED          | FAIL, vendor class                                                                      | same signature as the previous failure | BROKEN (internal)                                                                | open incident (`PENDING_REVIEW`)                 |
| 4   | DEGRADED          | FAIL, vendor class                                                                      | different signature                    | DEGRADED, streak reset to 1                                                      |                                                  |
| 5   | any               | FAIL, NETWORK_TRANSIENT / TIMEOUT                                                       | under 4 in a row                       | unchanged; DEGRADED from HEALTHY                                                 |                                                  |
| 6   | any               | FAIL, NETWORK_TRANSIENT / TIMEOUT                                                       | 4 in a row                             | BROKEN (internal)                                                                | open incident (likely registry or vendor outage) |
| 7   | any               | CRAWL_ERROR, COMPILER_ERROR, HARNESS_ERROR, NEEDS_CREDENTIALS, UNKNOWN; any SKIPPED run |                                        | unchanged                                                                        | admin queue item, never an incident              |
| 8   | BROKEN            | FAIL                                                                                    | new signature                          | BROKEN                                                                           | `signature_changed` on the open incident         |
| 9   | HEALTHY           | FAIL with the signature of an incident resolved in the last 7 days                      |                                        | BROKEN                                                                           | reopen that incident, `recurred`                 |

Vendor classes: `DEPENDENCY_RESOLUTION`, `API_DRIFT`, `DOCS_SNIPPET_ERROR`, `RUNTIME_VERSION`. An invalid cycle (`ctx.cycleValid` false) produces no transitions, only one `cycle_ignored`.

### Decisions the spec table leaves open

- **Harness versions (P9d).** A failure under a different harness version than the one that recorded the last failure is never the second of two consecutive failures: the streak is forgotten (`comparableState`) and the failure counts as a first one. `ToolState.lastFailureHarnessVersion` records the version (null on a tool with failure memory means version 1; a PASS clears it). A version bump on its own therefore never changes a status: HEALTHY and DEGRADED stay until the tool fails twice under the new version.
- **PASS while BROKEN** changes nothing until the second consecutive pass (`consecutivePasses` counts passes; a failure resets it to 0).
- **A transient failure never touches the vendor streak** (`consecutiveFailures`, `lastFailureSignature`), and a vendor failure or a pass resets `transientStreak`: "4 in a row" means consecutive.
- **A transient failure while BROKEN** is not a signature change. Row 8 compares the new signature with the **open incident's**.
- **Row 9 needs a HEALTHY tool and no open incident** (the database allows one open incident per tool). The 7-day window is inclusive and measured against `run.finishedAt`; with several matches the most recently resolved incident is reopened.
- **Row 9 applies to transient classes too** (an incident opened by 4 transient failures can recur on one).
- **`plan_regressed`**: a SKIPPED run at a manual step whose `reachedLevel` is below `ctx.previousReachedLevel` queues one `admin_queue` item with that reason instead of the generic `skipped`.
- **A FAIL with no class, or a vendor/transient class with no signature**, is queued as `unclassified`: it cannot be compared with earlier failures.
- **Defensive repair**: a BROKEN tool with no open incident (should not exist) opens one (`trigger: 'repair'`) instead of losing the failure; idempotence holds because `incident_opened` is never emitted when `ctx.openIncident` is set.
- Spec text outside the table, not done here: the public mapping (internal BROKEN with `PENDING_REVIEW` shows as DEGRADED) is the API/view's job, and a `FALSE_POSITIVE` review (resolve, reset streaks) is an admin action.

## Testing

`pnpm --filter @qsr/status test` runs with a **100% coverage gate**. Besides the row tests there is a matrix over every status, run kind and failure class, signature relation (none / same as last / different / matches a recent or an old resolved incident / equals or differs from the open one), `cycleValid` and open-incident presence (about 9,000 cases) asserting that `evaluate` never throws, returns valid states and events, and keeps the invariants (for instance: only a PASS can leave BROKEN; `incident_opened` always means the tool is BROKEN with no incident already open; an invalid cycle changes nothing). Idempotence and immutability (frozen inputs) have their own tests, and the suite was checked against hand-made mutations of the engine (an off-by-one in the 7-day window, a pass count of 3, a missing open-incident guard, a transient streak of 3, a slow DEGRADED recovery, an ignored invalid cycle): each is caught.
