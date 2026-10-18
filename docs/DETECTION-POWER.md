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

- **Inputs:** the cached extraction and accepted plan of each target (the cached copy of the page the plan was compiled from; no new crawl, no model call). 51 targets were considered; 46 had a control that passed and are in the statistics; 5 skipped or excluded (listed below).
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

46 of 51 controls passed. 1 control failed once and was run again; 0 passed the second time.

| Target           | Why it is not in the statistics                                                        |
| ---------------- | -------------------------------------------------------------------------------------- |
| anthropic-python | vendor calls are off for this target (pass --allow-vendor-calls to run it)             |
| cerebras-python  | vendor calls are off for this target (pass --allow-vendor-calls to run it)             |
| hono-node        | the control did not pass twice: SKIPPED at s1 (NEEDS_CREDENTIALS, skipped.manual_step) |
| openrouter-node  | vendor calls are off for this target (pass --allow-vendor-calls to run it)             |
| resend-python    | vendor calls are off for this target (pass --allow-vendor-calls to run it)             |

### Targets run again as a whole

Targets run again: chalk-node: its level changed under harness v3 (its run step shows no evidence of a vendor, so it is level 2 and is reported as executed locally): the whole target was run again under harness v3, locally, with no vendor request
Targets run again: dotenv-python: its level changed under harness v3 (its run step shows no evidence of a vendor, so it is level 2 and is reported as executed locally): the whole target was run again under harness v3, locally, with no vendor request
Targets run again: loguru-python: its level changed under harness v3 (its run step shows no evidence of a vendor, so it is level 2 and is reported as executed locally): the whole target was run again under harness v3, locally, with no vendor request
Targets run again: anthropic-python: it now has an L3 step whose run makes a request to a vendor (a dummy key). Under the request budget qsr mutate does not run it unless given --allow-vendor-calls, so its mutants are recorded as not run, and the earlier results (measured on its old plan without that step) are replaced
Targets run again: openrouter-node: it now has an L3 step whose run makes a request to a vendor (a dummy key). Under the request budget qsr mutate does not run it unless given --allow-vendor-calls, so its mutants are recorded as not run, and the earlier results (measured on its old plan without that step) are replaced
Targets run again: cerebras-python: it now has an L3 step whose run makes a request to a vendor (a dummy key). Under the request budget qsr mutate does not run it unless given --allow-vendor-calls, so its mutants are recorded as not run, and the earlier results (measured on its old plan without that step) are replaced
Targets run again: resend-python: it now has an L3 step whose run makes a request to a vendor (a dummy key). Under the request budget qsr mutate does not run it unless given --allow-vendor-calls, so its mutants are recorded as not run, and the earlier results (measured on its old plan without that step) are replaced

## Results

Targets at each level (the level its control reached): L1 6, L2 35, L3 2. A fourth category, **executed locally (no vendor)**, holds the 3 targets that declare no vendor is involved (a library whose snippet runs on the runner): their results are reported here, apart, and are not an L3 result. A cell below says how many mutants were tested, how many of those targets had at least one, and how many mutants were left out because the plan had no site for the operator (`no site`), the real validator refused the pair (`invalid`) or the harness itself failed.

**Limits that apply to every rate here:** L3 rests on 2 targets (anthropic-node, resend-node) until the shadow-L3 targets are promoted, so no L3 detection percentage is quoted. 97 mutants had no site to change (95 code-level, 2 install-level) and are in no rate. A rate over a handful of targets is an order of magnitude, not a percentage.

### Install-level mutants

Operators: pkg_typo, version_pin.

| Level                        | Targets at this level | Tested | Detected | Rate       | Targets with a tested mutant | Correct class | No site | Invalid | Harness errors | Not run (vendor calls off) |
| ---------------------------- | --------------------- | ------ | -------- | ---------- | ---------------------------- | ------------- | ------- | ------- | -------------- | -------------------------- |
| L1                           | 6                     | 12     | 12       | 100%       | 6                            | 12 of 12      | 0       | 0       | 0              | 0                          |
| L2                           | 35                    | 68     | 68       | 100%       | 34                           | 68 of 68      | 2       | 0       | 0              | 0                          |
| L3                           | 2                     | 4      | 4        | not quoted | 2                            | 4 of 4        | 0       | 0       | 0              | 8                          |
| Executed locally (no vendor) | 3                     | 6      | 6        | 100%       | 3                            | 6 of 6        | 0       | 0       | 0              | 0                          |

### Code-level mutants

Operators: renamed_symbol, renamed_method, deep_import, syntax_error, option_misnamed.

| Level                        | Targets at this level | Tested | Detected | Rate       | Targets with a tested mutant | Correct class | No site | Invalid | Harness errors | Not run (vendor calls off) |
| ---------------------------- | --------------------- | ------ | -------- | ---------- | ---------------------------- | ------------- | ------- | ------- | -------------- | -------------------------- |
| L1                           | 6                     | 0      | 0        | n/a        | 0                            | n/a           | 30      | 0       | 0              | 0                          |
| L2                           | 35                    | 121    | 64       | 53%        | 35                           | 64 of 64      | 53      | 1       | 0              | 0                          |
| L3                           | 2                     | 9      | 7        | not quoted | 2                            | 7 of 7        | 5       | 0       | 0              | 16                         |
| Executed locally (no vendor) | 3                     | 8      | 8        | 100%       | 3                            | 8 of 8        | 7       | 0       | 0              | 0                          |

## Harness versions, same mutants, same seed

Code-level mutants by level (install-level mutants are shown below the table). Each cell: detected of tested, rate, targets with a tested mutant.

| Level                        | harness v1                          | harness v2                          | with the export check (experiment)  |
| ---------------------------- | ----------------------------------- | ----------------------------------- | ----------------------------------- |
| L1                           | none tested                         | none tested                         | none tested                         |
| L2                           | 56 of 121 (46%), 35 targets         | 64 of 121 (53%), 35 targets         | 80 of 121 (66%), 35 targets         |
| L3                           | 7 of 9 (rate not quoted), 2 targets | 7 of 9 (rate not quoted), 2 targets | 7 of 9 (rate not quoted), 2 targets |
| Executed locally (no vendor) | 8 of 8 (100%), 3 targets            | 8 of 8 (100%), 3 targets            | 8 of 8 (100%), 3 targets            |

| Install-level                | harness v1                          | harness v2                          | with the export check (experiment)  |
| ---------------------------- | ----------------------------------- | ----------------------------------- | ----------------------------------- |
| L1                           | 12 of 12 (100%), 6 targets          | 12 of 12 (100%), 6 targets          | 12 of 12 (100%), 6 targets          |
| L2                           | 68 of 68 (100%), 34 targets         | 68 of 68 (100%), 34 targets         | 68 of 68 (100%), 34 targets         |
| L3                           | 4 of 4 (rate not quoted), 2 targets | 4 of 4 (rate not quoted), 2 targets | 4 of 4 (rate not quoted), 2 targets |
| Executed locally (no vendor) | 6 of 6 (100%), 3 targets            | 6 of 6 (100%), 3 targets            | 6 of 6 (100%), 3 targets            |

Newly detected under the newer harness: 8 (ably-python:deep_import, clickhouse-python:deep_import, mocha-node:syntax_error, posthog-python:deep_import, pytest-python:deep_import, sentry-python:deep_import, upstash-redis-python:deep_import, vitest-node:syntax_error).

Detected before and surviving now: 0. A mutant that survives a newer harness after being detected by the older one is a regression to be explained, not tuned away.

### By operator

| Operator          | Detected (all levels together) | Correct class | Invalid | Not applicable |
| ----------------- | ------------------------------ | ------------- | ------- | -------------- |
| `pkg_typo`        | 45 of 45                       | 45 of 45      | 0       | 1              |
| `version_pin`     | 45 of 45                       | 45 of 45      | 0       | 1              |
| `renamed_symbol`  | 3 of 19                        | 3 of 3        | 0       | 28             |
| `renamed_method`  | 2 of 17                        | 2 of 2        | 0       | 30             |
| `deep_import`     | 35 of 36                       | 35 of 35      | 0       | 11             |
| `syntax_error`    | 39 of 40                       | 39 of 39      | 0       | 6              |
| `option_misnamed` | 0 of 26                        | n/a           | 1       | 20             |

### By operator and level (detected of tested)

| Operator          | L1  | L2    | L3  | Executed locally (no vendor) |
| ----------------- | --- | ----- | --- | ---------------------------- |
| `pkg_typo`        | 6/6 | 34/34 | 2/2 | 3/3                          |
| `version_pin`     | 6/6 | 34/34 | 2/2 | 3/3                          |
| `renamed_symbol`  | -   | 0/16  | 1/1 | 2/2                          |
| `renamed_method`  | -   | 0/15  | 2/2 | -                            |
| `deep_import`     | -   | 30/31 | 2/2 | 3/3                          |
| `syntax_error`    | -   | 34/35 | 2/2 | 3/3                          |
| `option_misnamed` | -   | 0/24  | 0/2 | -                            |

### Classification: expected against assigned

Every detected mutant with a fixed expectation got an expected class.

## Survivors: mutants the monitor did not see

59 mutants passed. They fall into these patterns (most common first):

| #   | Operator          | Level | Count | Why the monitor could not see it                                                                                                                                                                                                                                                                                                                                                                     | Targets                                                                                             |
| --- | ----------------- | ----- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 1   | `option_misnamed` | L2    | 19    | The plan never runs the snippet (the run reaches L2). The L2 checks parse the file (`node --check`, or TypeScript syntax diagnostics) and resolve each import specifier from node_modules; they do not load the package, so they cannot see which names it exports. An option name is only meaningful to the vendor's code at call time.                                                             | ably-node, ajv-node, drizzle-node, fastify-node, honeybadger-node, launchdarkly-node, +13           |
| 2   | `renamed_method`  | L2    | 14    | The plan never runs the snippet (the run reaches L2). The L2 checks parse the file (`node --check`, or TypeScript syntax diagnostics) and resolve each import specifier from node_modules; they do not load the package, so they cannot see which names it exports. A method the object no longer has is only found when it is called.                                                               | ajv-node, drizzle-node, e2b-node, fastify-node, honeybadger-node, loops-node, +8                    |
| 3   | `renamed_symbol`  | L2    | 13    | The plan never runs the snippet (the run reaches L2). The L2 checks parse the file (`node --check`, or TypeScript syntax diagnostics) and resolve each import specifier from node_modules; they do not load the package, so they cannot see which names it exports. A name the package no longer exports is invisible until the code runs.                                                           | drizzle-node, e2b-node, launchdarkly-node, loops-node, neon-serverless-node, node-postgres-node, +7 |
| 4   | `option_misnamed` | L2    | 5     | The plan never runs the snippet (the run reaches L2). The L2 checks compile the file (`py_compile`) and look up the top-level module of each import; they do not import the package, so they cannot see which names it provides. An option name is only meaningful to the vendor's code at call time.                                                                                                | clickhouse-python, polars-python, posthog-python, sentry-python, upstash-redis-python               |
| 5   | `renamed_symbol`  | L2    | 3     | The plan never runs the snippet (the run reaches L2). The L2 checks compile the file (`py_compile`) and look up the top-level module of each import; they do not import the package, so they cannot see which names it provides. A name the package no longer exports is invisible until the code runs.                                                                                              | ably-python, posthog-python, upstash-redis-python                                                   |
| 6   | `option_misnamed` | L3    | 2     | The snippet ran and still passed: the vendor SDK ignores an option it does not know, or the run ended with an authentication error before options were validated (an auth error counts as a pass).                                                                                                                                                                                                   | anthropic-node, resend-node                                                                         |
| 7   | `deep_import`     | L2    | 1     | The L2 checks compile the file (`py_compile`) and look up the top-level module of each import; they do not import the package, so they cannot see which names it provides. A sub-module path that does not exist is only found when the module is imported, and the plan does not run the snippet.                                                                                                   | click-python                                                                                        |
| 8   | `renamed_method`  | L2    | 1     | The plan never runs the snippet (the run reaches L2). The L2 checks compile the file (`py_compile`) and look up the top-level module of each import; they do not import the package, so they cannot see which names it provides. A method the object no longer has is only found when it is called.                                                                                                  | ably-python                                                                                         |
| 9   | `syntax_error`    | L2    | 1     | The syntax check passed although a bracket or quote was removed. Either (1) the file is a .js file that uses import where no package.json says type module: node --check then exits 0 WITHOUT parsing the file (found by this run and reproduced in the sandbox image), so a broken ES-module .js file passes; or (2) the edit landed inside a string or template literal, which the parser accepts. | neon-serverless-node                                                                                |

### Every survivor

| Target               | Level | Operator          | Change                                                                                                                      |
| -------------------- | ----- | ----------------- | --------------------------------------------------------------------------------------------------------------------------- |
| ably-node            | L2    | `option_misnamed` | option clientId -> clientIdQsr in: clientId: 'my-first-client'                                                              |
| ably-python          | L2    | `renamed_symbol`  | AblyRealtime -> AblyRealtime_qsr (from 'ably')                                                                              |
| ably-python          | L2    | `renamed_method`  | ably_realtime.connection.once_async( -> ably_realtime.connection.once_async_qsr(                                            |
| ajv-node             | L2    | `renamed_method`  | ajv.compile( -> ajv.compileQsr(                                                                                             |
| ajv-node             | L2    | `option_misnamed` | option allErrors -> allErrorsQsr in: const ajv = new Ajv() // options can be passed, e.g. {allErrors: true}                 |
| anthropic-node       | L3    | `option_misnamed` | option role -> roleQsr in: role: "user",                                                                                    |
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
| pino-node            | L2    | `renamed_method`  | logger.child( -> logger.childQsr(                                                                                           |
| pino-node            | L2    | `option_misnamed` | option a -> aQsr in: const child = logger.child({ a: 'property' })                                                          |
| polars-python        | L2    | `option_misnamed` | option try_parse_dates -> try_parse_dates_qsr in: df_csv = pl.read_csv("docs/assets/data/output.csv", try_parse_dates=True) |
| posthog-node         | L2    | `renamed_symbol`  | PostHog -> PostHogQsr (from 'posthog-node')                                                                                 |
| posthog-node         | L2    | `renamed_method`  | client.shutdown( -> client.shutdownQsr(                                                                                     |
| posthog-python       | L2    | `renamed_symbol`  | Posthog -> Posthog_qsr (from 'posthog')                                                                                     |
| posthog-python       | L2    | `option_misnamed` | option host -> host_qsr in: posthog = Posthog('<ph_project_token>', host='https://us.i.posthog.com')                        |
| pusher-node          | L2    | `option_misnamed` | option cluster -> clusterQsr in: cluster: "APP_CLUSTER",                                                                    |
| resend-node          | L3    | `option_misnamed` | option from -> fromQsr in: from: 'Acme <onboarding@resend.dev>',                                                            |
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

4 of 41 of the runs failed (10%); 5 had no earlier major to install.

| Target                  | Level | Change                                                         | Result   | Class                 | Rule                          |
| ----------------------- | ----- | -------------------------------------------------------------- | -------- | --------------------- | ----------------------------- |
| ably-node               | L2    | ably -> ably@1                                                 | survived |                       |                               |
| ably-python             | L2    | ably -> 'ably<3'                                               | survived |                       |                               |
| ajv-node                | L2    | ajv -> ajv@7                                                   | survived |                       |                               |
| chai-node               | L1    | chai -> chai@5                                                 | survived |                       |                               |
| cheerio-node            | L2    | cheerio -> cheerio@0                                           | survived |                       |                               |
| click-python            | L2    | click -> 'click<8'                                             | survived |                       |                               |
| clickhouse-python       | L2    | clickhouse-connect -> 'clickhouse-connect<1'                   | survived |                       |                               |
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
| pino-node               | L2    | pino -> pino@9                                                 | survived |                       |                               |
| polars-python           | L2    | polars -> 'polars<2'                                           | survived |                       |                               |
| posthog-node            | L2    | posthog-node -> posthog-node@4                                 | survived |                       |                               |
| posthog-python          | L2    | posthog -> 'posthog<7'                                         | survived |                       |                               |
| pydantic-install-python | L1    | pydantic -> 'pydantic<2'                                       | survived |                       |                               |
| pytest-python           | L2    | pytest -> 'pytest<9'                                           | survived |                       |                               |
| resend-node             | L3    | resend -> resend@5                                             | survived |                       |                               |
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
| chalk-node              | local | chalk -> chalk@5                                               | survived |                       |                               |
| dotenv-python           | local | python-dotenv -> 'python-dotenv<1'                             | survived |                       |                               |

## With the export check (`qsr-check-exports`; in production it runs in shadow mode only)

Same mutants, same seed; here the check FAILS the run, which production does not do. A target that opted out (`harness.skipExportCheck`) is not checked. **False positives on controls: 0.**

| Code-level mutants           | Without the check                   | With the check                      |
| ---------------------------- | ----------------------------------- | ----------------------------------- |
| L1                           | none tested                         | none tested                         |
| L2                           | 64 of 121 (53%), 35 targets         | 80 of 121 (66%), 35 targets         |
| L3                           | 7 of 9 (rate not quoted), 2 targets | 7 of 9 (rate not quoted), 2 targets |
| Executed locally (no vendor) | 8 of 8 (100%), 3 targets            | 8 of 8 (100%), 3 targets            |

| By operator       | Without the check | With the check |
| ----------------- | ----------------- | -------------- |
| `pkg_typo`        | 45 of 45          | 45 of 45       |
| `version_pin`     | 45 of 45          | 45 of 45       |
| `renamed_symbol`  | 3 of 19           | 18 of 19       |
| `renamed_method`  | 2 of 17           | 2 of 17        |
| `deep_import`     | 35 of 36          | 36 of 36       |
| `syntax_error`    | 39 of 40          | 39 of 40       |
| `option_misnamed` | 0 of 26           | 0 of 26        |

Newly detected: 16 (ably-python:renamed_symbol, click-python:deep_import, drizzle-node:renamed_symbol, e2b-node:renamed_symbol, loops-node:renamed_symbol, neon-serverless-node:renamed_symbol, node-postgres-node:renamed_symbol, posthog-node:renamed_symbol, posthog-python:renamed_symbol, slack-node:renamed_symbol, turso-libsql-node:renamed_symbol, upstash-qstash-node:renamed_symbol, ...).

## Recommendation

Written by hand after reading the numbers above. Nothing below is enabled in production except what is said to be: harness version 3 (the two fixes of version 2 and the rule that an L3 claim needs evidence), the export check in **shadow** mode, and the L3 step of every target marked `l3.mode: shadow` in **shadow** mode (recorded, never counted): `cerebras-python`, `openrouter-node`, `resend-python` and `slack-node` at the time of writing. A test keeps the list the website shows equal to the target files.

### What changed since the first measurement (harness version 1)

Same mutants, same seed, same targets on both sides of the table above (a target that is not in the newer results is left out of the older side too).

- **Version 2 fixes** (an ES-module `.js` is parsed as a module; a dotted Python import resolves its full path): code-level mutants at L2 went from **56 of 121 to 64 of 121** detected, 8 more, none missed that was detected before. They are Python `deep_import` and the syntax mutants of `mocha-node` and `vitest-node`.
- **Version 3: an L3 claim needs evidence that a vendor was reached** (an auth pattern in the run step's output). Two things follow:
  - **L3 rests on 2 targets** (`anthropic-node`, `resend-node`) in this measurement, until the shadow-L3 targets are promoted. A target whose snippet runs a vendor client for real counts; one that exits 0 without anything showing a vendor does not. **No L3 detection percentage is quoted anywhere** until then, here or on the site: the L3 rows above show counts only, and 9 code-level mutants over two targets is not a rate.
  - **Three targets execute locally, with no vendor** (`chalk-node`, `dotenv-python`, `loguru-python`, libraries with no API). They used to count as L3. Their results are kept and reported apart, as their own category beside L1, L2 and L3: **6 of 6 install-level and 8 of 8 code-level mutants detected**, over 3 targets. They say the harness checks work on a snippet that runs; they say nothing about reaching a vendor.
- **Four targets are not measured in this run** (`anthropic-python`, `openrouter-node`, `cerebras-python`, `resend-python`): they now have an L3 step that makes a request to a vendor with a dummy key, and `qsr mutate` makes no vendor request unless given `--allow-vendor-calls`. Their mutants are recorded as not run (24 of them), and the results measured on their old plans (which had no such step) were replaced.
- **`slack-node` gained its shadow L3 step after this measurement.** Its results here are those of its earlier level 2 plan, and it is counted at L2. It is not one of the targets L3 rests on, and its request, like the others', is not made by `qsr mutate`. A new measurement with `--allow-vendor-calls` would replace them.

### What the survivors say

Of the 59 mutants that still pass, 57 are at L2 and two at L3. Almost all are one thing: **names that only exist at run time**. At L2 the plan does not run the snippet, and the checks read the file without loading the package, so a renamed import, a renamed method or a misnamed option is invisible: at L2, `renamed_symbol` 0 of 16, `renamed_method` 0 of 15 and `option_misnamed` 0 of 24 were detected. The other two L2 survivors are a Python package that builds its submodules at run time (`click-python`, deliberately not reported) and a bracket removed inside a template literal (`neon-serverless-node`, valid code). An L3 pass does not see an option either: an authentication error with a dummy key counts, so `option_misnamed` at L3 was 0 of 2.

### The export check, in shadow mode (`qsr-check-exports`)

It loads the installed package once, in the sandbox, with the network blocked in-process, and checks that every named import exists. It never calls anything a package exports. It runs after the normal checks in every production execute job and only records its answer (`shadow_export_check`); it changes no outcome, level, classification, status, incident, badge or page (tests pin it). `qsr shadow-report --days N` shows what it said: across the first cycles under harness version 2 it recorded 300 passes, 0 failures and 6 skips (the opted-out `launchdarkly-node`), and no target is a false-positive candidate.

Measured on the same mutants as an experiment that does fail runs: code-level mutants at L2 **64 of 121 to 80 of 121** (66%); `renamed_symbol` (all levels) 3 of 19 to 18 of 19; `deep_import` 35 of 36 to 36 of 36; `renamed_method` 2 of 17 and `option_misnamed` 0 of 26 unchanged. **False positives on the unmutated controls: 0** (after two fixes this measurement found: a TypeScript call used as an object property value was read as a type, and the per-target opt-out did not apply to the experiment). 16 more mutants are detected, all classified as expected.

**`launchdarkly-node`.** Its docs snippet is TypeScript (`import { init, LDContext, LDOptions }`, the last two are types) with no signal a program can see. The check recognises TypeScript by a `ts`/`tsx` fence or TypeScript-only syntax and then skips type-only imports, which handles every other target of that shape; for this one the plan writes `index.js`. Teaching the compiler to write it as `.ts` would change the compiled plan, which means bumping `COMPILER_VERSION` and invalidating all production plans, so the target opts out instead (`harness.skipExportCheck: true`, with a required `reason`). The cost is one target the check does not measure.

**What it does not do.** It does not help with renamed methods or misnamed options: those need the client built and called, which is what L3 is for. It executes package code at import (a package that cannot be loaded here is reported as unchecked, never as a failure). And it would change what L2 means, from "installs, parses, imports resolve" to also "every named import exists".

**Not promoted.** Promotion is a decision for the owner after `qsr shadow-report`. A reasonable bar: at least 28 cycles in which no target is a false-positive candidate that a person cannot explain from its docs. If promoted, it is a public wording change (`/methodology`, the badge text, the level explanations), agreed before any cycle enforces it.

### What we can honestly say publicly

Facts the wording rests on (harness version 2 checks, version 3 levels; one run on one machine; 46 targets measured): install-level mutants **90 of 90** caught (L1 12 of 12, L2 68 of 68 over 34 targets, executed locally 6 of 6; the two targets that count at L3 added 4 of 4, which is not quoted as a rate); code-level mutants **64 of 121 at L2 over 35 targets**, **8 of 8 for snippets executed locally over 3 targets**, and **no L3 rate** (two targets). 97 further mutants (95 code-level, 2 install-level) had no site to change and are counted nowhere. None of it measures how often real quickstarts break.

Two candidate wordings. Neither blends install-level and code-level mutants, and neither quotes an L3 rate.

- **Candidate A (a sentence for each kind):** "We tested the monitor by breaking quickstarts on purpose. It caught every broken install command (90 of 90), which is largely the package manager's doing. For broken code it caught 64 of 121 at L2, and we do not quote a rate for L3 because it rests on two quickstarts. A green L2 badge means the quickstart installs, parses and its imports resolve, not that the names it uses still exist."
- **Candidate B (about the badge, install result as a separate fact):** "A green L2 badge means the quickstart installs, parses and its imports resolve. In our own tests, planting broken code in 35 quickstarts, L2 noticed 64 of 121 planted breakages, all of them syntax errors and import paths that do not exist; it noticed none of the 55 renamed names, renamed methods or misnamed options, because those only exist at run time. Level 3, where the snippet reaches the vendor, rests on two quickstarts so far and we quote no rate for it. (Broken install commands are caught by npm and pip, 90 of 90, and say nothing about the code.)"

**Preferred: B.** It attaches the number to the thing a reader sees (the badge) and to the level they are looking at, keeps the install result out of the headline where it would flatter the monitor, and says plainly what is not claimed.

Per level, for the page that explains the badges:

- **L1:** "A pass at L1 means the package named in the install command exists and installs on a clean machine today. It does not say the code works."
- **L2:** "A pass at L2 means the install works, the code parses, and the packages it imports resolve. It does not mean the names the code uses still exist: at L2 our planted renamed imports were noticed 0 of 16 times, renamed methods 0 of 15 and misnamed options 0 of 24."
- **L3:** "A pass at L3 means the snippet ran against the vendor's own client library and the vendor's answer, an authentication error for a made-up key, shows it was reached. It does not show the options are right. It rests on a small number of quickstarts, so we quote no detection rate for it."
- **Executed locally:** "Some quickstarts are libraries with no service behind them. Their snippet runs on our machine and counts as such; it never counts as Level 3."

None of this measures how often real quickstarts break. It measures what the monitor can see.
