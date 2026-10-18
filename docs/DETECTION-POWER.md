# Detection power: what the monitor can and cannot see

Generated 2026-10-18T04:35:46.556Z by `qsr mutate`. Raw results: `docs/detection-power.json`. Seed `p9c`, harness version 2, harness checks: production (syntax, imports).

There is no single detection rate in this document, on purpose. Mutants that change the **install** command (a typo in a package name, a version that does not exist) are stopped by npm or pip whatever the harness checks do; mutants that change the **code** (a symbol, a method, a deep path, syntax, an option) are what the harness checks are for. Averaging the two would credit the monitor for what the package manager does anyway, so they are reported apart and by level.

## What this is

A quickstart monitor that always says "passing" would look perfect, so we also measured whether it notices a quickstart that is broken. We took each target's own cached docs extraction and its accepted plan, made one small, deterministic change to the docs code (a typo in a package name, a renamed import, a missing bracket, and so on), ran the changed quickstart in the same Docker sandbox the monitor uses, and recorded whether the monitor failed it and how it classified the failure. The mutated plan and the mutated docs lines are changed identically, so the real grounding validator still accepts them: the monitor is not tricked by an obviously forged plan, it is shown a plausible broken quickstart.

## What this does NOT show

- **It does not show how often real quickstarts break.** The mutants are invented by us. A high detection rate says the monitor would notice that kind of break; it says nothing about how many real ones exist.
- It does not show that the monitor is right when it says "passing" for a quickstart we did not mutate. Each mutant is one planned kind of fault, in one place.
- The operators are a list we chose. Faults outside it (a changed default, a behaviour change, an authentication flow that moved) are not measured. A rate here is a rate over this list.
- Per-level rates have small denominators (see the counts); read them as orders of magnitude, not as precise percentages.
- Each mutant ran once, on one machine, on the day shown above. Dependency versions resolved on that day.

## Method

- **Inputs:** the cached extraction and accepted plan of each target (the cached copy of the page the plan was compiled from; no new crawl, no model call). 51 targets were considered; 50 had a control that passed and are in the statistics; 1 skipped or excluded (listed below).
- **Controls first.** The unmutated plan is run once more (and once more if it fails). A target whose control does not pass twice is left out of every statistic.
- **Mutants.** Operators are deterministic and seeded. Each applies the same textual change to the docs lines and to the plan step that quotes them, then the real grounding validator must accept the pair; if it does not, the mutant is discarded and counted as `invalid`. A plan with no site for an operator is `not applicable`.
- **Levels.** A target is placed at the level its control reached: **L1** the quickstart only installs (the page showed no code to build), **L2** it installs and its code is parsed and its imports resolved, **L3** its snippet ran and reached the vendor's API (an authentication error with a dummy key counts as a pass).
- **Detected** means the run failed. **Survived** means it passed. Correct classification is only judged where an operator has a fixed expectation, against our documented mapping.

### Operators

| Operator                      | What changes                                                                                                                          | Expected class        |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| `pkg_typo`                    | Two letters are inserted into the name of the first package the docs install (a name that does not exist).                            | DEPENDENCY_RESOLUTION |
| `version_pin`                 | The first package the docs install is pinned to version 999.999.999.                                                                  | DEPENDENCY_RESOLUTION |
| `renamed_symbol`              | A named import (or destructured require, or from-import) is renamed everywhere in the snippet, so the package no longer has the name. | API_DRIFT             |
| `renamed_method`              | A method called on an object the snippet created is renamed to one the SDK does not have.                                             | API_DRIFT             |
| `deep_import`                 | The module specifier of an import of the installed package gets a sub-path that does not exist.                                       | API_DRIFT             |
| `syntax_error`                | A closing bracket (or a closing quote) is removed from one line of the snippet.                                                       | DOCS_SNIPPET_ERROR    |
| `option_misnamed`             | The name of an option (an object key or a keyword argument) inside a call is changed. No fixed expectation: what happens is recorded. | none: recorded        |
| `previous_major` (experiment) | EXPERIMENT, not an oracle. The previous major version of the package is installed while the snippet stays as the docs show it today.  | none: recorded        |

## Controls and exclusions

50 of 51 controls passed. 1 control failed once and was run again; 0 passed the second time.

| Target    | Why it is not in the statistics                                                        |
| --------- | -------------------------------------------------------------------------------------- |
| hono-node | the control did not pass twice: SKIPPED at s1 (NEEDS_CREDENTIALS, skipped.manual_step) |

### Mutants run again after an environment failure

The network (registry DNS) failed twice for these mutants in the full run, which is a harness error and no verdict. Each was run again alone with the same seed; the verdict below is from that run. Nothing else was re-run or chosen.

- anthropic-python `syntax_error`: the network failed twice in the full run (a harness error); run again alone, same seed
- anthropic-python `option_misnamed`: the network failed twice in the full run (a harness error); run again alone, same seed
- anthropic-python `previous_major`: the network failed twice in the full run (a harness error); run again alone, same seed
- cerebras-python `option_misnamed`: the network failed twice in the full run (a harness error); run again alone, same seed
- cerebras-python `previous_major`: the network failed twice in the full run (a harness error); run again alone, same seed

## Results

Targets at each level (the level its control reached): L1 6, L2 39, L3 5. A cell below says how many mutants were tested, how many of those targets had at least one, and how many mutants were left out because the plan had no site for the operator (`no site`), the real validator refused the pair (`invalid`) or the harness itself failed.

**Limits that apply to every rate here:** L3 rests on 5 targets. 97 mutants had no site to change (95 code-level, 2 install-level) and are in no rate. A rate over a handful of targets is an order of magnitude, not a percentage.

### Install-level mutants

Operators: pkg_typo, version_pin.

| Level | Targets at this level | Tested | Detected | Rate | Targets with a tested mutant | Correct class | No site | Invalid | Harness errors |
| ----- | --------------------- | ------ | -------- | ---- | ---------------------------- | ------------- | ------- | ------- | -------------- |
| L1    | 6                     | 12     | 12       | 100% | 6                            | 12 of 12      | 0       | 0       | 0              |
| L2    | 39                    | 76     | 76       | 100% | 38                           | 76 of 76      | 2       | 0       | 0              |
| L3    | 5                     | 10     | 10       | 100% | 5                            | 10 of 10      | 0       | 0       | 0              |

### Code-level mutants

Operators: renamed_symbol, renamed_method, deep_import, syntax_error, option_misnamed.

| Level | Targets at this level | Tested | Detected | Rate | Targets with a tested mutant | Correct class | No site | Invalid | Harness errors |
| ----- | --------------------- | ------ | -------- | ---- | ---------------------------- | ------------- | ------- | ------- | -------------- |
| L1    | 6                     | 0      | 0        | n/a  | 0                            | n/a           | 30      | 0       | 0              |
| L2    | 39                    | 137    | 71       | 52%  | 39                           | 71 of 71      | 57      | 1       | 0              |
| L3    | 5                     | 17     | 15       | 88%  | 5                            | 15 of 15      | 8       | 0       | 0              |

## Harness versions, same mutants, same seed

Code-level mutants by level (install-level mutants are shown below the table). Each cell: detected of tested, rate, targets with a tested mutant.

| Level | harness v1                  | harness v2                  | with the export check (experiment) |
| ----- | --------------------------- | --------------------------- | ---------------------------------- |
| L1    | none tested                 | none tested                 | none tested                        |
| L2    | 61 of 137 (45%), 39 targets | 71 of 137 (52%), 39 targets | 90 of 137 (66%), 39 targets        |
| L3    | 15 of 17 (88%), 5 targets   | 15 of 17 (88%), 5 targets   | 15 of 17 (88%), 5 targets          |

| Install-level | harness v1                  | harness v2                  | with the export check (experiment) |
| ------------- | --------------------------- | --------------------------- | ---------------------------------- |
| L1            | 12 of 12 (100%), 6 targets  | 12 of 12 (100%), 6 targets  | 12 of 12 (100%), 6 targets         |
| L2            | 76 of 76 (100%), 38 targets | 76 of 76 (100%), 38 targets | 76 of 76 (100%), 38 targets        |
| L3            | 10 of 10 (100%), 5 targets  | 10 of 10 (100%), 5 targets  | 10 of 10 (100%), 5 targets         |

Newly detected under the newer harness: 10 (ably-python:deep_import, anthropic-python:deep_import, clickhouse-python:deep_import, mocha-node:syntax_error, posthog-python:deep_import, pytest-python:deep_import, resend-python:deep_import, sentry-python:deep_import, upstash-redis-python:deep_import, vitest-node:syntax_error).

Detected before and surviving now: 0. A mutant that survives a newer harness after being detected by the older one is a regression to be explained, not tuned away.

### By operator

| Operator          | Detected | Rate | Correct class | Invalid | Not applicable |
| ----------------- | -------- | ---- | ------------- | ------- | -------------- |
| `pkg_typo`        | 49 of 49 | 100% | 49 of 49      | 0       | 1              |
| `version_pin`     | 49 of 49 | 100% | 49 of 49      | 0       | 1              |
| `renamed_symbol`  | 3 of 22  | 14%  | 3 of 3        | 0       | 28             |
| `renamed_method`  | 2 of 20  | 10%  | 2 of 2        | 0       | 30             |
| `deep_import`     | 38 of 39 | 97%  | 38 of 38      | 0       | 11             |
| `syntax_error`    | 43 of 44 | 98%  | 43 of 43      | 0       | 6              |
| `option_misnamed` | 0 of 29  | 0%   | n/a           | 1       | 20             |

### By operator and level (detected of tested)

| Operator          | L1  | L2    | L3  |
| ----------------- | --- | ----- | --- |
| `pkg_typo`        | 6/6 | 38/38 | 5/5 |
| `version_pin`     | 6/6 | 38/38 | 5/5 |
| `renamed_symbol`  | -   | 0/19  | 3/3 |
| `renamed_method`  | -   | 0/18  | 2/2 |
| `deep_import`     | -   | 33/34 | 5/5 |
| `syntax_error`    | -   | 38/39 | 5/5 |
| `option_misnamed` | -   | 0/27  | 0/2 |

### Classification: expected against assigned

Every detected mutant with a fixed expectation got an expected class.

## Survivors: mutants the monitor did not see

68 mutants passed. They fall into these patterns (most common first):

| #   | Operator          | Level | Count | Why the monitor could not see it                                                                                                                                                                                                                                                                                                                                                                     | Targets                                                                                                |
| --- | ----------------- | ----- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 1   | `option_misnamed` | L2    | 20    | The plan never runs the snippet (the run reaches L2). The L2 checks parse the file (`node --check`, or TypeScript syntax diagnostics) and resolve each import specifier from node_modules; they do not load the package, so they cannot see which names it exports. An option name is only meaningful to the vendor's code at call time.                                                             | ably-node, ajv-node, drizzle-node, fastify-node, honeybadger-node, launchdarkly-node, +14              |
| 2   | `renamed_method`  | L2    | 15    | The plan never runs the snippet (the run reaches L2). The L2 checks parse the file (`node --check`, or TypeScript syntax diagnostics) and resolve each import specifier from node_modules; they do not load the package, so they cannot see which names it exports. A method the object no longer has is only found when it is called.                                                               | ajv-node, drizzle-node, e2b-node, fastify-node, honeybadger-node, loops-node, +9                       |
| 3   | `renamed_symbol`  | L2    | 14    | The plan never runs the snippet (the run reaches L2). The L2 checks parse the file (`node --check`, or TypeScript syntax diagnostics) and resolve each import specifier from node_modules; they do not load the package, so they cannot see which names it exports. A name the package no longer exports is invisible until the code runs.                                                           | drizzle-node, e2b-node, launchdarkly-node, loops-node, neon-serverless-node, node-postgres-node, +8    |
| 4   | `option_misnamed` | L2    | 7     | The plan never runs the snippet (the run reaches L2). The L2 checks compile the file (`py_compile`) and look up the top-level module of each import; they do not import the package, so they cannot see which names it provides. An option name is only meaningful to the vendor's code at call time.                                                                                                | anthropic-python, cerebras-python, clickhouse-python, polars-python, posthog-python, sentry-python, +1 |
| 5   | `renamed_symbol`  | L2    | 5     | The plan never runs the snippet (the run reaches L2). The L2 checks compile the file (`py_compile`) and look up the top-level module of each import; they do not import the package, so they cannot see which names it provides. A name the package no longer exports is invisible until the code runs.                                                                                              | ably-python, cerebras-python, posthog-python, resend-python, upstash-redis-python                      |
| 6   | `renamed_method`  | L2    | 3     | The plan never runs the snippet (the run reaches L2). The L2 checks compile the file (`py_compile`) and look up the top-level module of each import; they do not import the package, so they cannot see which names it provides. A method the object no longer has is only found when it is called.                                                                                                  | ably-python, anthropic-python, cerebras-python                                                         |
| 7   | `option_misnamed` | L3    | 2     | The snippet ran and still passed: the vendor SDK ignores an option it does not know, or the run ended with an authentication error before options were validated (an auth error counts as a pass).                                                                                                                                                                                                   | anthropic-node, resend-node                                                                            |
| 8   | `deep_import`     | L2    | 1     | The L2 checks compile the file (`py_compile`) and look up the top-level module of each import; they do not import the package, so they cannot see which names it provides. A sub-module path that does not exist is only found when the module is imported, and the plan does not run the snippet.                                                                                                   | click-python                                                                                           |
| 9   | `syntax_error`    | L2    | 1     | The syntax check passed although a bracket or quote was removed. Either (1) the file is a .js file that uses import where no package.json says type module: node --check then exits 0 WITHOUT parsing the file (found by this run and reproduced in the sandbox image), so a broken ES-module .js file passes; or (2) the edit landed inside a string or template literal, which the parser accepts. | neon-serverless-node                                                                                   |

### Every survivor

| Target               | Level | Operator          | Change                                                                                                                      |
| -------------------- | ----- | ----------------- | --------------------------------------------------------------------------------------------------------------------------- |
| ably-node            | L2    | `option_misnamed` | option clientId -> clientIdQsr in: clientId: 'my-first-client'                                                              |
| ably-python          | L2    | `renamed_symbol`  | AblyRealtime -> AblyRealtime_qsr (from 'ably')                                                                              |
| ably-python          | L2    | `renamed_method`  | ably_realtime.connection.once_async( -> ably_realtime.connection.once_async_qsr(                                            |
| ajv-node             | L2    | `renamed_method`  | ajv.compile( -> ajv.compileQsr(                                                                                             |
| ajv-node             | L2    | `option_misnamed` | option allErrors -> allErrorsQsr in: const ajv = new Ajv() // options can be passed, e.g. {allErrors: true}                 |
| anthropic-node       | L3    | `option_misnamed` | option role -> roleQsr in: role: "user",                                                                                    |
| anthropic-python     | L2    | `renamed_method`  | client.messages.create( -> client.messages.create_qsr(                                                                      |
| anthropic-python     | L2    | `option_misnamed` | option model -> model_qsr in: model="claude-opus-5-5",                                                                      |
| cerebras-python      | L2    | `renamed_symbol`  | Cerebras -> Cerebras_qsr (from 'cerebras.cloud.sdk')                                                                        |
| cerebras-python      | L2    | `renamed_method`  | client.chat.completions.create( -> client.chat.completions.create_qsr(                                                      |
| cerebras-python      | L2    | `option_misnamed` | option model -> model_qsr in: model="qwen-3.8-27b",                                                                         |
| click-python         | L2    | `deep_import`     | click -> click.qsr_missing                                                                                                  |
| clickhouse-python    | L2    | `option_misnamed` | option password -> password_qsr in: password="password",                                                                    |
| drizzle-node         | L2    | `renamed_symbol`  | varchar -> varcharQsr (from 'drizzle-orm/pg-core')                                                                          |
| drizzle-node         | L2    | `renamed_method`  | db.delete( -> db.deleteQsr(                                                                                                 |
| drizzle-node         | L2    | `option_misnamed` | option age -> ageQsr in: age: 31,                                                                                           |
| e2b-node             | L2    | `renamed_symbol`  | Sandbox -> SandboxQsr (from '@e2b/code-interpreter')                                                                        |
| e2b-node             | L2    | `renamed_method`  | sbx.files.list( -> sbx.files.listQsr(                                                                                       |
| fastify-node         | L2    | `renamed_method`  | fastify.listen( -> fastify.listenQsr(                                                                                       |
| fastify-node         | L2    | `option_misnamed` | option hello -> helloQsr in: reply.send({ hello: 'world' })                                                                 |
| honeybadger-node     | L2    | `renamed_method`  | Honeybadger.configure( -> Honeybadger.configureQsr(                                                                         |
| honeybadger-node     | L2    | `option_misnamed` | option apiKey -> apiKeyQsr in: apiKey: "[ YOUR API KEY HERE ]",                                                             |
| launchdarkly-node    | L2    | `renamed_symbol`  | Observability -> ObservabilityQsr (from '@launchdarkly/observability-node')                                                 |
| launchdarkly-node    | L2    | `option_misnamed` | option plugins -> pluginsQsr in: plugins: [ new Observability(), ],                                                         |
| loops-node           | L2    | `renamed_symbol`  | LoopsClient -> LoopsClientQsr (from 'loops')                                                                                |
| loops-node           | L2    | `renamed_method`  | loops.createContact( -> loops.createContactQsr(                                                                             |
| loops-node           | L2    | `option_misnamed` | option email -> emailQsr in: email: "test@example.com",                                                                     |
| mailgun-node         | L2    | `renamed_method`  | mailgun.client( -> mailgun.clientQsr(                                                                                       |
| mailgun-node         | L2    | `option_misnamed` | option text -> textQsr in: text: "Testing some Mailgun awesomness!",                                                        |
| mixpanel-node        | L2    | `renamed_method`  | Mixpanel.init( -> Mixpanel.initQsr(                                                                                         |
| neon-serverless-node | L2    | `renamed_symbol`  | neon -> neonQsr (from '@neondatabase/serverless')                                                                           |
| neon-serverless-node | L2    | `renamed_method`  | sql.transaction( -> sql.transactionQsr(                                                                                     |
| neon-serverless-node | L2    | `syntax_error`    | closing bracket removed from: sql`INSERT INTO posts (title) VALUES (${'Third post'})`,                                      |
| neon-serverless-node | L2    | `option_misnamed` | option connectionString -> connectionStringQsr in: const pool = new Pool({ connectionString: process.env.DATABASE_URL });   |
| node-postgres-node   | L2    | `renamed_symbol`  | Client -> ClientQsr (from 'pg')                                                                                             |
| node-postgres-node   | L2    | `renamed_method`  | client.query( -> client.queryQsr(                                                                                           |
| openrouter-node      | L2    | `renamed_symbol`  | OpenRouter -> OpenRouterQsr (from '@openrouter/sdk')                                                                        |
| openrouter-node      | L2    | `renamed_method`  | client.chat.send( -> client.chat.sendQsr(                                                                                   |
| openrouter-node      | L2    | `option_misnamed` | option model -> modelQsr in: model: '~openai/gpt-sol-latest',                                                               |
| pino-node            | L2    | `renamed_method`  | logger.child( -> logger.childQsr(                                                                                           |
| pino-node            | L2    | `option_misnamed` | option a -> aQsr in: const child = logger.child({ a: 'property' })                                                          |
| polars-python        | L2    | `option_misnamed` | option try_parse_dates -> try_parse_dates_qsr in: df_csv = pl.read_csv("docs/assets/data/output.csv", try_parse_dates=True) |
| posthog-node         | L2    | `renamed_symbol`  | PostHog -> PostHogQsr (from 'posthog-node')                                                                                 |
| posthog-node         | L2    | `renamed_method`  | client.shutdown( -> client.shutdownQsr(                                                                                     |
| posthog-python       | L2    | `renamed_symbol`  | Posthog -> Posthog_qsr (from 'posthog')                                                                                     |
| posthog-python       | L2    | `option_misnamed` | option host -> host_qsr in: posthog = Posthog('<ph_project_token>', host='https://us.i.posthog.com')                        |
| pusher-node          | L2    | `option_misnamed` | option cluster -> clusterQsr in: cluster: "APP_CLUSTER",                                                                    |
| resend-node          | L3    | `option_misnamed` | option from -> fromQsr in: from: 'Acme <onboarding@resend.dev>',                                                            |
| resend-python        | L2    | `renamed_symbol`  | ResendError -> ResendError_qsr (from 'resend.exceptions')                                                                   |
| rollbar-node         | L2    | `option_misnamed` | option captureUnhandledRejections -> captureUnhandledRejectionsQsr in: captureUnhandledRejections: true,                    |
| sentry-node          | L2    | `renamed_method`  | Sentry.init( -> Sentry.initQsr(                                                                                             |
| sentry-node          | L2    | `option_misnamed` | option dsn -> dsnQsr in: dsn: "https://examplePublicKey@o0.ingest.sentry.io/0",                                             |
| sentry-python        | L2    | `option_misnamed` | option send_default_pii -> send_default_pii_qsr in: send_default_pii=True,                                                  |
| slack-node           | L2    | `renamed_symbol`  | WebClient -> WebClientQsr (from '@slack/web-api')                                                                           |
| slack-node           | L2    | `option_misnamed` | option channel -> channelQsr in: channel: conversationId,                                                                   |
| turso-libsql-node    | L2    | `renamed_symbol`  | createClient -> createClientQsr (from '@libsql/client')                                                                     |
| turso-libsql-node    | L2    | `option_misnamed` | option url -> urlQsr in: url: process.env.TURSO_DATABASE_URL,                                                               |
| upstash-qstash-node  | L2    | `renamed_symbol`  | Client -> ClientQsr (from '@upstash/qstash')                                                                                |
| upstash-qstash-node  | L2    | `option_misnamed` | option token -> tokenQsr in: token: "<QSTASH_TOKEN>",                                                                       |
| upstash-redis-node   | L2    | `renamed_symbol`  | Redis -> RedisQsr (from '@upstash/redis')                                                                                   |
| upstash-redis-node   | L2    | `renamed_method`  | redis.set( -> redis.setQsr(                                                                                                 |
| upstash-redis-node   | L2    | `option_misnamed` | option name -> nameQsr in: await redis.hset('people', {name: 'joe'})                                                        |
| upstash-redis-python | L2    | `renamed_symbol`  | Redis -> Redis_qsr (from 'upstash_redis.asyncio')                                                                           |
| upstash-redis-python | L2    | `option_misnamed` | option url -> url_qsr in: redis = Redis(url="UPSTASH_REDIS_REST_URL", token="UPSTASH_REDIS_REST_TOKEN")                     |
| upstash-vector-node  | L2    | `renamed_symbol`  | Index -> IndexQsr (from '@upstash/vector')                                                                                  |
| upstash-vector-node  | L2    | `option_misnamed` | option url -> urlQsr in: url: "<UPSTASH_VECTOR_REST_URL>",                                                                  |
| vitest-node          | L2    | `renamed_symbol`  | test -> testQsr (from 'vitest')                                                                                             |
| zod-node             | L2    | `option_misnamed` | option name -> nameQsr in: name: z.string(),                                                                                |

### Invalid mutants

1 mutants were discarded because the real validator refused the mutated pair:

- ably-python `option_misnamed`: the real grounding validator refused the mutated pair: s6 file.content_mismatch

## Experiment (not an oracle): docs ahead of the package

The previous major version of the package is installed while the snippet stays as the docs show it today. This is **not** a measure of detection power: there is no fixed expectation, the plan is run through an executor override (not a docs quotation), and whether a snippet written for the current major breaks on the previous one says more about the package than about the monitor. Reported here only to show what happens.

5 of 45 of the runs failed (11%); 5 had no earlier major to install.

| Target                  | Level | Change                                                         | Result   | Class                 | Rule                          |
| ----------------------- | ----- | -------------------------------------------------------------- | -------- | --------------------- | ----------------------------- |
| ably-node               | L2    | ably -> ably@1                                                 | survived |                       |                               |
| ably-python             | L2    | ably -> 'ably<3'                                               | survived |                       |                               |
| ajv-node                | L2    | ajv -> ajv@7                                                   | survived |                       |                               |
| anthropic-python        | L2    | anthropic -> 'anthropic<1'                                     | survived |                       |                               |
| cerebras-python         | L2    | cerebras_cloud_sdk -> 'cerebras_cloud_sdk<1'                   | detected | DEPENDENCY_RESOLUTION | dependency.pip_no_matching    |
| chai-node               | L1    | chai -> chai@5                                                 | survived |                       |                               |
| chalk-node              | L3    | chalk -> chalk@5                                               | survived |                       |                               |
| cheerio-node            | L2    | cheerio -> cheerio@0                                           | survived |                       |                               |
| click-python            | L2    | click -> 'click<8'                                             | survived |                       |                               |
| clickhouse-python       | L2    | clickhouse-connect -> 'clickhouse-connect<1'                   | survived |                       |                               |
| dotenv-python           | L3    | python-dotenv -> 'python-dotenv<1'                             | survived |                       |                               |
| drizzle-node            | L2    | drizzle-orm@rc -> drizzle-orm@0                                | survived |                       |                               |
| e2b-node                | L2    | @e2b/code-interpreter -> @e2b/code-interpreter@1               | survived |                       |                               |
| fastify-node            | L2    | fastify -> fastify@4                                           | survived |                       |                               |
| flask-install-python    | L1    | Flask -> 'Flask<3'                                             | survived |                       |                               |
| honeybadger-node        | L2    | @honeybadger-io/js -> @honeybadger-io/js@5                     | survived |                       |                               |
| jest-node               | L2    | jest -> jest@29                                                | survived |                       |                               |
| jinja-intro-python      | L1    | Jinja2 -> 'Jinja2<3'                                           | survived |                       |                               |
| launchdarkly-node       | L2    | @launchdarkly/node-server-sdk -> @launchdarkly/node-server-... | detected | DEPENDENCY_RESOLUTION | dependency.npm_eresolve       |
| loops-node              | L2    | loops -> loops@6                                               | survived |                       |                               |
| mailgun-node            | L2    | mailgun.js -> mailgun.js@13                                    | survived |                       |                               |
| mocha-node              | L2    | mocha -> mocha@11                                              | survived |                       |                               |
| neon-serverless-node    | L2    | @neondatabase/serverless -> @neondatabase/serverless@0         | survived |                       |                               |
| node-postgres-node      | L2    | pg -> pg@7                                                     | survived |                       |                               |
| openrouter-node         | L2    | @openrouter/sdk -> @openrouter/sdk@0                           | survived |                       |                               |
| pino-node               | L2    | pino -> pino@9                                                 | survived |                       |                               |
| polars-python           | L2    | polars -> 'polars<2'                                           | survived |                       |                               |
| posthog-node            | L2    | posthog-node -> posthog-node@4                                 | survived |                       |                               |
| posthog-python          | L2    | posthog -> 'posthog<7'                                         | survived |                       |                               |
| pydantic-install-python | L1    | pydantic -> 'pydantic<2'                                       | survived |                       |                               |
| pytest-python           | L2    | pytest -> 'pytest<9'                                           | survived |                       |                               |
| resend-node             | L3    | resend -> resend@5                                             | survived |                       |                               |
| resend-python           | L2    | resend -> 'resend<2'                                           | survived |                       |                               |
| rollbar-node            | L2    | rollbar -> rollbar@3                                           | survived |                       |                               |
| rxjs-node               | L1    | rxjs -> rxjs@6                                                 | survived |                       |                               |
| sentry-node             | L2    | @sentry/node -> @sentry/node@10                                | survived |                       |                               |
| sentry-python           | L2    | "sentry-sdk" -> 'sentry-sdk<2'                                 | survived |                       |                               |
| slack-node              | L2    | @slack/web-api -> @slack/web-api@7                             | survived |                       |                               |
| socketio-node           | L1    | socket.io -> socket.io@3                                       | survived |                       |                               |
| upstash-qstash-node     | L2    | @upstash/qstash -> @upstash/qstash@1                           | detected | DEPENDENCY_RESOLUTION | dependency.npm_etarget        |
| upstash-redis-node      | L2    | @upstash/redis -> @upstash/redis@0                             | survived |                       |                               |
| upstash-redis-python    | L2    | upstash-redis -> 'upstash-redis<1'                             | survived |                       |                               |
| upstash-vector-node     | L2    | @upstash/vector -> @upstash/vector@0                           | detected | DEPENDENCY_RESOLUTION | dependency.npm_etarget        |
| vitest-node             | L2    | vitest -> vitest@4                                             | detected | DEPENDENCY_RESOLUTION | dependency.npm_resolver_crash |
| zod-node                | L2    | zod -> zod@3                                                   | survived |                       |                               |

## With the export check (`qsr-check-exports`; in production it runs in shadow mode only)

Same mutants, same seed; here the check FAILS the run, which production does not do. A target that opted out (`harness.skipExportCheck`) is not checked. **False positives on controls: 0.**

| Code-level mutants | Without the check           | With the check              |
| ------------------ | --------------------------- | --------------------------- |
| L1                 | none tested                 | none tested                 |
| L2                 | 71 of 137 (52%), 39 targets | 90 of 137 (66%), 39 targets |
| L3                 | 15 of 17 (88%), 5 targets   | 15 of 17 (88%), 5 targets   |

| By operator       | Without the check | With the check |
| ----------------- | ----------------- | -------------- |
| `pkg_typo`        | 49 of 49          | 49 of 49       |
| `version_pin`     | 49 of 49          | 49 of 49       |
| `renamed_symbol`  | 3 of 22           | 21 of 22       |
| `renamed_method`  | 2 of 20           | 2 of 20        |
| `deep_import`     | 38 of 39          | 39 of 39       |
| `syntax_error`    | 43 of 44          | 43 of 44       |
| `option_misnamed` | 0 of 29           | 0 of 29        |

Newly detected: 19 (ably-python:renamed_symbol, cerebras-python:renamed_symbol, click-python:deep_import, drizzle-node:renamed_symbol, e2b-node:renamed_symbol, loops-node:renamed_symbol, neon-serverless-node:renamed_symbol, node-postgres-node:renamed_symbol, openrouter-node:renamed_symbol, posthog-node:renamed_symbol, posthog-python:renamed_symbol, resend-python:renamed_symbol, ...).

## Recommendation

Written by hand after reading the numbers above. Nothing below is enabled in production except what is said to be: harness version 2 (the two fixes) and the export check in **shadow** mode, where it is recorded and never acted on.

### What changed since the first measurement (P9c, harness version 1)

Same mutants, same seed, same 50 controls. The controls behave identically under both versions (50 of 51 pass at the same levels, `hono-node` is skipped by design: no PASS became a FAIL). Of the code-level mutants, 10 more are now detected and none that was detected before is missed:

- **ES-module `.js` is parsed as a module** (`mocha-node` and `vitest-node` syntax mutants; `node --check` skipped such files). `syntax_error` 41 of 44 became 43 of 44.
- **A dotted Python import resolves its full path** (`import pkg.missing` fails, classified API_DRIFT like a Node deep import). `deep_import` 30 of 39 became 38 of 39. The one that still passes is `click-python`: `click` has a module-level `__getattr__`, and a package that registers or lazily loads submodules at run time is deliberately not reported, because a missing file proves nothing there.

### What the survivors say

Of the 68 mutants that still pass under version 2, 66 are at L2 and two at L3. Almost all are one thing: **names that only exist at run time**. At L2 the plan does not run the snippet and the checks read the file without loading the package, so a renamed import, a renamed method or a misnamed option is invisible (`renamed_symbol` 0 of 19, `renamed_method` 0 of 18, `option_misnamed` 0 of 27 at L2). An L3 pass is no better for options: an authentication error with a dummy key counts as a pass (`option_misnamed` 0 of 2 at L3).

### The export check, in shadow mode (`qsr-check-exports`)

It loads the installed package once, in the sandbox, with the network blocked in-process, and checks that every named import exists. It never calls anything the package exports. It runs **after** the normal checks in every production execute job and its answer is stored per step as `shadow_export_check`; it changes no outcome, level, classification, status, incident, badge or public page (tests pin it). `qsr shadow-report --days N` shows what it said.

Measured on the same mutants (survivors re-run, controls re-run), as an experiment that does fail runs:

| Code-level mutants       | harness v1      | harness v2      | v2 with the export check |
| ------------------------ | --------------- | --------------- | ------------------------ |
| L2, 39 targets           | 61 of 137 (45%) | 71 of 137 (52%) | 90 of 137 (66%)          |
| L3, 5 targets            | 15 of 17 (88%)  | 15 of 17 (88%)  | 15 of 17 (88%)           |
| `renamed_symbol` (all L) | 3 of 22         | 3 of 22         | 21 of 22                 |
| `renamed_method`         | 2 of 20         | 2 of 20         | 2 of 20                  |
| `option_misnamed`        | 0 of 29         | 0 of 29         | 0 of 29                  |

19 more mutants are detected with the check, all classified as expected (API_DRIFT). The one `renamed_symbol` it cannot see is `launchdarkly-node`, which is opted out (below).

**False positives on the 50 unmutated controls: 0, after two fixes found by this measurement.** The first run failed `launchdarkly-node` (a TypeScript snippet without a TypeScript signal, see below). Its mutants also showed that a TypeScript name used as `key: name(...)` was wrongly read as a type annotation (`drizzle-node`); a call is a value, and that is fixed and tested.

**launchdarkly-node, stated plainly.** The snippet is TypeScript (`import { init, LDContext, LDOptions }`, the last two are types) but has no signal a program can see: an untagged fence and imports only. The check recognises TypeScript by a `ts`/`tsx` fence or TypeScript-only syntax and then skips type-only imports, which fixes every other target of that shape. For this one target the plan writes `index.js`. Teaching the compiler to write it as `.ts` would change the compiled plan, which means bumping `COMPILER_VERSION` and invalidating all 51 production plans; that was not done. Instead the target opts out with `harness.skipExportCheck: true` and a required `reason`. The cost is one target the check does not measure.

**What it does not do.** It does not help with renamed methods or misnamed options (2 of 20, 0 of 29): those need the client built and called, which is what L3 is for. It executes package code at import (a package that cannot be loaded here is reported as unchecked, never as a failure). And it changes what L2 would mean, from "installs, parses, imports resolve" to also "every named import exists".

**Not promoted.** P9b reads the shadow report first. A reasonable bar before it can count: a week or more of cycles (28 or more) in which no target is a false-positive candidate that a person cannot explain from its docs. If it is promoted, that is a public wording change (`/methodology`, the badge text, the level explanations), agreed before any cycle enforces it.

### What we can honestly say publicly

Facts the wording rests on (harness version 2, 50 targets, one run on one machine): install-level mutants 98 of 98 caught (L1 12 of 12 over 6 targets, L2 76 of 76 over 38, L3 10 of 10 over 5), code-level mutants 71 of 137 at L2 over 39 targets and 15 of 17 at L3 over **5 targets**, with 97 more mutants having no site to change and so counted nowhere. None of it measures how often real quickstarts break.

Two candidate wordings. Neither blends install-level and code-level mutants.

- **Candidate A (a sentence for each kind):** "We tested the monitor by breaking quickstarts on purpose. It caught every broken install command (98 of 98), which is largely the package manager's doing. For broken code it caught 71 of 137 at L2 and 15 of 17 at L3 (five targets), so a green L2 badge means the quickstart installs, parses and its imports resolve, not that the names it uses still exist."
- **Candidate B (about the badge, install result as a separate fact):** "A green L2 badge means the quickstart installs, parses and its imports resolve. In our own tests, planting broken code in 39 quickstarts, L2 noticed 71 of 137 planted breakages, all of them syntax errors and import paths that do not exist; it noticed none of the 64 renamed names, renamed methods or misnamed options, because those only exist at run time. L3 noticed 15 of 17, on five quickstarts. (Broken install commands are caught by npm and pip, 98 of 98, and say nothing about the code.)"

**Preferred: B.** It attaches the number to the thing a reader sees (the badge) and to the level they are looking at, it keeps the install result out of the headline where it would flatter the monitor, and it does not rest on one sentence that can be quoted without its denominators. A is shorter and fine for a methodology footnote. Whichever is used, quote the denominators and the five L3 targets with it.

Per level, for the page that explains the badges:

- **L1:** "A pass at L1 means the package named in the install command exists and installs on a clean machine today. It does not say the code works."
- **L2:** "A pass at L2 means the install works, the code parses, and the packages it imports resolve. It does not mean the names the code uses still exist: at L2 our planted renamed imports were noticed 0 of 19 times, renamed methods 0 of 18 and misnamed options 0 of 27."
- **L3:** "A pass at L3 means the snippet ran against the vendor's own client library and reached the vendor's API. A misnamed option is not noticed (0 of 2), because an authentication error with a dummy key counts as a pass. Five targets."

None of this measures how often real quickstarts break. It measures what the monitor can see.
