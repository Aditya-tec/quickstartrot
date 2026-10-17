# Detection power: what the monitor can and cannot see

Generated 2026-10-17T19:40:09.528Z by `qsr mutate`. Raw results: `docs/detection-power.json`. Seed `p9c`, harness checks: production (syntax, imports).

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

50 of 51 controls passed. 1 failed once and were run again; 0 of those passed the second time.

| Target    | Why it is not in the statistics                                                        |
| --------- | -------------------------------------------------------------------------------------- |
| hono-node | the control did not pass twice: SKIPPED at s1 (NEEDS_CREDENTIALS, skipped.manual_step) |

## Results

**Overall: 174 of 252 mutants detected (69%).** Correct class where one was expected: 174 of 174 (100%). Not counted: 1 invalid, 97 not applicable, 0 harness errors.

The overall figure mixes very different kinds of target. Read it by level:

### By level

| Level | Targets | Detected   | Rate | Correct class |
| ----- | ------- | ---------- | ---- | ------------- |
| L1    | 6       | 12 of 12   | 100% | 12 of 12      |
| L2    | 39      | 137 of 213 | 64%  | 137 of 137    |
| L3    | 5       | 25 of 27   | 93%  | 25 of 25      |

### By operator

| Operator          | Detected | Rate | Correct class | Invalid | Not applicable |
| ----------------- | -------- | ---- | ------------- | ------- | -------------- |
| `pkg_typo`        | 49 of 49 | 100% | 49 of 49      | 0       | 1              |
| `version_pin`     | 49 of 49 | 100% | 49 of 49      | 0       | 1              |
| `renamed_symbol`  | 3 of 22  | 14%  | 3 of 3        | 0       | 28             |
| `renamed_method`  | 2 of 20  | 10%  | 2 of 2        | 0       | 30             |
| `deep_import`     | 30 of 39 | 77%  | 30 of 30      | 0       | 11             |
| `syntax_error`    | 41 of 44 | 93%  | 41 of 41      | 0       | 6              |
| `option_misnamed` | 0 of 29  | 0%   | n/a           | 1       | 20             |

### By operator and level (detected of tested)

| Operator          | L1  | L2    | L3  |
| ----------------- | --- | ----- | --- |
| `pkg_typo`        | 6/6 | 38/38 | 5/5 |
| `version_pin`     | 6/6 | 38/38 | 5/5 |
| `renamed_symbol`  | -   | 0/19  | 3/3 |
| `renamed_method`  | -   | 0/18  | 2/2 |
| `deep_import`     | -   | 25/34 | 5/5 |
| `syntax_error`    | -   | 36/39 | 5/5 |
| `option_misnamed` | -   | 0/27  | 0/2 |

### Classification: expected against assigned

Every detected mutant with a fixed expectation got an expected class.

## Survivors: mutants the monitor did not see

78 mutants passed. They fall into these patterns (most common first):

| #   | Operator          | Level | Count | Why the monitor could not see it                                                                                                                                                                                                                                                                                                           | Targets                                                                                                |
| --- | ----------------- | ----- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| 1   | `option_misnamed` | L2    | 20    | The plan never runs the snippet (the run reaches L2). The L2 checks parse the file (`node --check`, or TypeScript syntax diagnostics) and resolve each import specifier from node_modules; they do not load the package, so they cannot see which names it exports. An option name is only meaningful to the vendor's code at call time.   | ably-node, ajv-node, drizzle-node, fastify-node, honeybadger-node, launchdarkly-node, +14              |
| 2   | `renamed_method`  | L2    | 15    | The plan never runs the snippet (the run reaches L2). The L2 checks parse the file (`node --check`, or TypeScript syntax diagnostics) and resolve each import specifier from node_modules; they do not load the package, so they cannot see which names it exports. A method the object no longer has is only found when it is called.     | ajv-node, drizzle-node, e2b-node, fastify-node, honeybadger-node, loops-node, +9                       |
| 3   | `renamed_symbol`  | L2    | 14    | The plan never runs the snippet (the run reaches L2). The L2 checks parse the file (`node --check`, or TypeScript syntax diagnostics) and resolve each import specifier from node_modules; they do not load the package, so they cannot see which names it exports. A name the package no longer exports is invisible until the code runs. | drizzle-node, e2b-node, launchdarkly-node, loops-node, neon-serverless-node, node-postgres-node, +8    |
| 4   | `deep_import`     | L2    | 9     | The L2 checks compile the file (`py_compile`) and look up the top-level module of each import; they do not import the package, so they cannot see which names it provides. A sub-module path that does not exist is only found when the module is imported, and the plan does not run the snippet.                                         | ably-python, anthropic-python, click-python, clickhouse-python, posthog-python, pytest-python, +3      |
| 5   | `option_misnamed` | L2    | 7     | The plan never runs the snippet (the run reaches L2). The L2 checks compile the file (`py_compile`) and look up the top-level module of each import; they do not import the package, so they cannot see which names it provides. An option name is only meaningful to the vendor's code at call time.                                      | anthropic-python, cerebras-python, clickhouse-python, polars-python, posthog-python, sentry-python, +1 |
| 6   | `renamed_symbol`  | L2    | 5     | The plan never runs the snippet (the run reaches L2). The L2 checks compile the file (`py_compile`) and look up the top-level module of each import; they do not import the package, so they cannot see which names it provides. A name the package no longer exports is invisible until the code runs.                                    | ably-python, cerebras-python, posthog-python, resend-python, upstash-redis-python                      |
| 7   | `renamed_method`  | L2    | 3     | The plan never runs the snippet (the run reaches L2). The L2 checks compile the file (`py_compile`) and look up the top-level module of each import; they do not import the package, so they cannot see which names it provides. A method the object no longer has is only found when it is called.                                        | ably-python, anthropic-python, cerebras-python                                                         |
| 8   | `syntax_error`    | L2    | 3     | The syntax check passed although a bracket or quote was removed: the edit landed in text the parser accepts (a string, a template literal or a docstring), or in a file the check does not parse.                                                                                                                                          | mocha-node, neon-serverless-node, vitest-node                                                          |
| 9   | `option_misnamed` | L3    | 2     | The snippet ran and still passed: the vendor SDK ignores an option it does not know, or the run ended with an authentication error before options were validated (an auth error counts as a pass).                                                                                                                                         | anthropic-node, resend-node                                                                            |

### Every survivor

| Target               | Level | Operator          | Change                                                                                                                      |
| -------------------- | ----- | ----------------- | --------------------------------------------------------------------------------------------------------------------------- |
| ably-node            | L2    | `option_misnamed` | option clientId -> clientIdQsr in: clientId: 'my-first-client'                                                              |
| ably-python          | L2    | `renamed_symbol`  | AblyRealtime -> AblyRealtime_qsr (from 'ably')                                                                              |
| ably-python          | L2    | `renamed_method`  | ably_realtime.connection.once_async( -> ably_realtime.connection.once_async_qsr(                                            |
| ably-python          | L2    | `deep_import`     | ably -> ably.qsr_missing                                                                                                    |
| ajv-node             | L2    | `renamed_method`  | ajv.compile( -> ajv.compileQsr(                                                                                             |
| ajv-node             | L2    | `option_misnamed` | option allErrors -> allErrorsQsr in: const ajv = new Ajv() // options can be passed, e.g. {allErrors: true}                 |
| anthropic-node       | L3    | `option_misnamed` | option role -> roleQsr in: role: "user",                                                                                    |
| anthropic-python     | L2    | `renamed_method`  | client.messages.create( -> client.messages.create_qsr(                                                                      |
| anthropic-python     | L2    | `deep_import`     | anthropic -> anthropic.qsr_missing                                                                                          |
| anthropic-python     | L2    | `option_misnamed` | option model -> model_qsr in: model="claude-opus-5-5",                                                                      |
| cerebras-python      | L2    | `renamed_symbol`  | Cerebras -> Cerebras_qsr (from 'cerebras.cloud.sdk')                                                                        |
| cerebras-python      | L2    | `renamed_method`  | client.chat.completions.create( -> client.chat.completions.create_qsr(                                                      |
| cerebras-python      | L2    | `option_misnamed` | option model -> model_qsr in: model="qwen-3.8-27b",                                                                         |
| click-python         | L2    | `deep_import`     | click -> click.qsr_missing                                                                                                  |
| clickhouse-python    | L2    | `deep_import`     | clickhouse_connect -> clickhouse_connect.qsr_missing                                                                        |
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
| mocha-node           | L2    | `syntax_error`    | closing bracket removed from: describe("#indexOf()", function () {                                                          |
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
| posthog-python       | L2    | `deep_import`     | posthog -> posthog.qsr_missing                                                                                              |
| posthog-python       | L2    | `option_misnamed` | option host -> host_qsr in: posthog = Posthog('<ph_project_token>', host='https://us.i.posthog.com')                        |
| pusher-node          | L2    | `option_misnamed` | option cluster -> clusterQsr in: cluster: "APP_CLUSTER",                                                                    |
| pytest-python        | L2    | `deep_import`     | pytest -> pytest.qsr_missing                                                                                                |
| resend-node          | L3    | `option_misnamed` | option from -> fromQsr in: from: 'Acme <onboarding@resend.dev>',                                                            |
| resend-python        | L2    | `renamed_symbol`  | ResendError -> ResendError_qsr (from 'resend.exceptions')                                                                   |
| resend-python        | L2    | `deep_import`     | resend -> resend.qsr_missing                                                                                                |
| rollbar-node         | L2    | `option_misnamed` | option captureUnhandledRejections -> captureUnhandledRejectionsQsr in: captureUnhandledRejections: true,                    |
| sentry-node          | L2    | `renamed_method`  | Sentry.init( -> Sentry.initQsr(                                                                                             |
| sentry-node          | L2    | `option_misnamed` | option dsn -> dsnQsr in: dsn: "https://examplePublicKey@o0.ingest.sentry.io/0",                                             |
| sentry-python        | L2    | `deep_import`     | sentry_sdk -> sentry_sdk.qsr_missing                                                                                        |
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
| upstash-redis-python | L2    | `deep_import`     | upstash_redis -> upstash_redis.qsr_missing                                                                                  |
| upstash-redis-python | L2    | `option_misnamed` | option url -> url_qsr in: redis = Redis(url="UPSTASH_REDIS_REST_URL", token="UPSTASH_REDIS_REST_TOKEN")                     |
| upstash-vector-node  | L2    | `renamed_symbol`  | Index -> IndexQsr (from '@upstash/vector')                                                                                  |
| upstash-vector-node  | L2    | `option_misnamed` | option url -> urlQsr in: url: "<UPSTASH_VECTOR_REST_URL>",                                                                  |
| vitest-node          | L2    | `renamed_symbol`  | test -> testQsr (from 'vitest')                                                                                             |
| vitest-node          | L2    | `syntax_error`    | closing bracket removed from: test('adds 1 + 2 to equal 3', () => {                                                         |
| zod-node             | L2    | `option_misnamed` | option name -> nameQsr in: name: z.string(),                                                                                |

### Invalid mutants

1 mutants were discarded because the real validator refused the mutated pair:

- ably-python `option_misnamed`: the real grounding validator refused the mutated pair: s6 file.content_mismatch

## Experiment (not an oracle): docs ahead of the package

The previous major version of the package is installed while the snippet stays as the docs show it today. This is **not** a measure of detection power: there is no fixed expectation, the plan is run through an executor override (not a docs quotation), and whether a snippet written for the current major breaks on the previous one says more about the package than about the monitor. Reported here only to show what happens.

5 of 45 of the runs failed (11%); 5 had no earlier major to install.

| Target                  | Level | Change                                                         | Result   | Class                 | Rule                       |
| ----------------------- | ----- | -------------------------------------------------------------- | -------- | --------------------- | -------------------------- |
| ably-node               | L2    | ably -> ably@1                                                 | survived |                       |                            |
| ably-python             | L2    | ably -> 'ably<3'                                               | survived |                       |                            |
| ajv-node                | L2    | ajv -> ajv@7                                                   | survived |                       |                            |
| anthropic-python        | L2    | anthropic -> 'anthropic<1'                                     | survived |                       |                            |
| cerebras-python         | L2    | cerebras_cloud_sdk -> 'cerebras_cloud_sdk<1'                   | detected | DEPENDENCY_RESOLUTION | dependency.pip_no_matching |
| chai-node               | L1    | chai -> chai@5                                                 | survived |                       |                            |
| chalk-node              | L3    | chalk -> chalk@5                                               | survived |                       |                            |
| cheerio-node            | L2    | cheerio -> cheerio@0                                           | survived |                       |                            |
| click-python            | L2    | click -> 'click<8'                                             | survived |                       |                            |
| clickhouse-python       | L2    | clickhouse-connect -> 'clickhouse-connect<1'                   | survived |                       |                            |
| dotenv-python           | L3    | python-dotenv -> 'python-dotenv<1'                             | survived |                       |                            |
| drizzle-node            | L2    | drizzle-orm@rc -> drizzle-orm@0                                | survived |                       |                            |
| e2b-node                | L2    | @e2b/code-interpreter -> @e2b/code-interpreter@1               | survived |                       |                            |
| fastify-node            | L2    | fastify -> fastify@4                                           | survived |                       |                            |
| flask-install-python    | L1    | Flask -> 'Flask<3'                                             | survived |                       |                            |
| honeybadger-node        | L2    | @honeybadger-io/js -> @honeybadger-io/js@5                     | survived |                       |                            |
| jest-node               | L2    | jest -> jest@29                                                | survived |                       |                            |
| jinja-intro-python      | L1    | Jinja2 -> 'Jinja2<3'                                           | survived |                       |                            |
| launchdarkly-node       | L2    | @launchdarkly/node-server-sdk -> @launchdarkly/node-server-... | detected | DEPENDENCY_RESOLUTION | dependency.npm_eresolve    |
| loops-node              | L2    | loops -> loops@6                                               | survived |                       |                            |
| mailgun-node            | L2    | mailgun.js -> mailgun.js@13                                    | survived |                       |                            |
| mocha-node              | L2    | mocha -> mocha@11                                              | survived |                       |                            |
| neon-serverless-node    | L2    | @neondatabase/serverless -> @neondatabase/serverless@0         | survived |                       |                            |
| node-postgres-node      | L2    | pg -> pg@7                                                     | survived |                       |                            |
| openrouter-node         | L2    | @openrouter/sdk -> @openrouter/sdk@0                           | survived |                       |                            |
| pino-node               | L2    | pino -> pino@9                                                 | survived |                       |                            |
| polars-python           | L2    | polars -> 'polars<2'                                           | survived |                       |                            |
| posthog-node            | L2    | posthog-node -> posthog-node@4                                 | survived |                       |                            |
| posthog-python          | L2    | posthog -> 'posthog<7'                                         | survived |                       |                            |
| pydantic-install-python | L1    | pydantic -> 'pydantic<2'                                       | survived |                       |                            |
| pytest-python           | L2    | pytest -> 'pytest<9'                                           | survived |                       |                            |
| resend-node             | L3    | resend -> resend@5                                             | survived |                       |                            |
| resend-python           | L2    | resend -> 'resend<2'                                           | survived |                       |                            |
| rollbar-node            | L2    | rollbar -> rollbar@3                                           | survived |                       |                            |
| rxjs-node               | L1    | rxjs -> rxjs@6                                                 | survived |                       |                            |
| sentry-node             | L2    | @sentry/node -> @sentry/node@10                                | survived |                       |                            |
| sentry-python           | L2    | "sentry-sdk" -> 'sentry-sdk<2'                                 | survived |                       |                            |
| slack-node              | L2    | @slack/web-api -> @slack/web-api@7                             | survived |                       |                            |
| socketio-node           | L1    | socket.io -> socket.io@3                                       | survived |                       |                            |
| upstash-qstash-node     | L2    | @upstash/qstash -> @upstash/qstash@1                           | detected | DEPENDENCY_RESOLUTION | dependency.npm_etarget     |
| upstash-redis-node      | L2    | @upstash/redis -> @upstash/redis@0                             | survived |                       |                            |
| upstash-redis-python    | L2    | upstash-redis -> 'upstash-redis<1'                             | survived |                       |                            |
| upstash-vector-node     | L2    | @upstash/vector -> @upstash/vector@0                           | detected | DEPENDENCY_RESOLUTION | dependency.npm_etarget     |
| vitest-node             | L2    | vitest -> vitest@4                                             | detected | UNKNOWN               | none                       |
| zod-node                | L2    | zod -> zod@3                                                   | survived |                       |                            |

## With the proposed export check (`qsr-check-exports`, experimental, off in production)

Same mutants, same seed. **False positives on controls: 1.** launchdarkly-node (the control did not pass twice: FAIL at qsr-check-exports (API_DRIFT, check.export_missing))

|                   | Before           | After            |
| ----------------- | ---------------- | ---------------- |
| Overall detection | 174 of 252 (69%) | 198 of 252 (79%) |
| L1                | 12 of 12 (100%)  | 12 of 12 (100%)  |
| L2                | 137 of 213 (64%) | 161 of 213 (76%) |
| L3                | 25 of 27 (93%)   | 25 of 27 (93%)   |
| `pkg_typo`        | 49 of 49         | 49 of 49         |
| `version_pin`     | 49 of 49         | 49 of 49         |
| `renamed_symbol`  | 3 of 22          | 16 of 22         |
| `renamed_method`  | 2 of 20          | 2 of 20          |
| `deep_import`     | 30 of 39         | 39 of 39         |
| `syntax_error`    | 41 of 44         | 43 of 44         |
| `option_misnamed` | 0 of 29          | 0 of 29          |

Newly detected: 24 (ably-python:renamed_symbol, ably-python:deep_import, anthropic-python:deep_import, cerebras-python:renamed_symbol, click-python:deep_import, clickhouse-python:deep_import, loops-node:renamed_symbol, mocha-node:syntax_error, neon-serverless-node:renamed_symbol, node-postgres-node:renamed_symbol, openrouter-node:renamed_symbol, posthog-node:renamed_symbol, ...).

## Recommendation

Written by hand after reading the numbers above. Nothing below is enabled in production.

### What the survivors say

Of the 78 mutants that passed, almost all are one thing: **names that only exist at run time**. At L2 the plan does not run the snippet, and the L2 checks read the file without loading the package. So an imported name, a called method or an option name that the package no longer has is invisible (`renamed_symbol` 0 of 19, `renamed_method` 0 of 18, `option_misnamed` 0 of 27 at L2). Two smaller causes were found while measuring:

1. **`node --check` does not parse an ES-module `.js` file.** For a `.js` file that uses `import` where no `package.json` says `"type": "module"`, `node --check` exits 0 without parsing it (reproduced in the sandbox image, Node 22.23). A broken file of that shape passes our syntax check (3 of the 44 syntax mutants, `mocha-node` and `vitest-node` among them). This is a bug in the harness check, not a property of L2.
2. **The Python imports check looks up only the top-level module**, so `import pkg.missing_submodule` passes (the 9 Python `deep_import` survivors).

### The smallest check that would help: `qsr-check-exports`

A third harness-owned check after syntax and imports, in the sandbox, with no vendor call:

- For every static **named** import of an installed package (`import { A } from 'pkg'`, `const { A } = require('pkg')`, `from pkg import A`) it loads the package once and checks that the name exists (an attribute or, for Python, a submodule), and that a dotted `import pkg.sub` can be imported. A missing name is classified **API_DRIFT** (new rule `check.export_missing`, with fixtures).
- It also parses an ES-module `.js` file as a module (a copy named `.mjs`), which closes the `node --check` gap above.
- **No network:** sockets, DNS and `fetch` throw while packages are loaded (in-process, not an OS-level block; the container itself still has a network, because the install step needs it). **No vendor call:** nothing a package exports is ever called; the only operations on a loaded package are a membership test, `hasattr` and `find_spec`.
- This is the only check that executes package code (an import runs the module body). A package that cannot be loaded here (a native module, a network call at import time) is reported as unchecked and never fails the quickstart.
- **TypeScript files are skipped**, because a named import there may be a type, which has no run-time export.

Behind a feature flag (`ExecuteDeps.exportsCheck`, `qsr mutate --exports-check`). **Not enabled for any production cycle:** `qsr execute` does not set it and a test pins that no workflow or probe module does.

**Same mutants, same seed (survivors re-run, controls re-run):**

|                                     | Before           | After            |
| ----------------------------------- | ---------------- | ---------------- |
| All mutants                         | 174 of 252 (69%) | 198 of 252 (79%) |
| L1                                  | 12 of 12         | 12 of 12         |
| L2                                  | 137 of 213 (64%) | 161 of 213 (76%) |
| L3                                  | 25 of 27         | 25 of 27         |
| `renamed_symbol`                    | 3 of 22          | 16 of 22         |
| `deep_import`                       | 30 of 39         | 39 of 39         |
| `syntax_error`                      | 41 of 44         | 43 of 44         |
| `renamed_method`, `option_misnamed` | 2 of 20, 0 of 29 | unchanged        |

All 24 newly detected mutants were classified as expected (API_DRIFT for a missing name, DOCS_SNIPPET_ERROR for the syntax cases). The mean time of a control run did not change (9.6 s before, 9.5 s after, 49 targets).

**The cost, stated plainly:**

- **One false positive in 50 controls.** `launchdarkly-node`: the docs snippet is TypeScript (`import { init, LDContext, LDOptions }`, where the last two are types) but the plan writes it to `index.js`, where those names do not exist at run time. The check is right about the file we would run, and wrong about the docs. Turning the check on means either teaching the compiler to write such a snippet as `.ts` or giving a target a way to opt out; it should not be turned on before one of them exists.
- It does not reach the 6 remaining `renamed_symbol` survivors (five are in TypeScript files, which it skips; the sixth is `launchdarkly-node`, whose control the check fails, so its mutants were not re-run) or the remaining syntax survivor (the removed bracket was inside a template literal, which is valid).
- **It does not help with renamed methods or misnamed options** (2 of 20 and 0 of 29). Those need the client to be constructed and called, which is what L3 is for, and L3 needs the vendor to accept a dummy key. We do not propose a larger check for them.
- **It changes what L2 means.** Today L2 says "installs, parses, imports resolve". With the check it would also say "every named import exists on the package". That is a public wording change (`/methodology`, the badge text, the level explanations) and should be agreed before any cycle runs it.

**To enable it, if you agree:** pass `exportsCheck: true` from `packages/cli/src/probe/execute.ts`, decide how a target opts out, change the wording of L2 on `/methodology`, and re-run `qsr mutate --all` to refresh these numbers.

### What we can honestly say publicly

- **L1:** "A pass at L1 means the package named in the docs' install command exists and installs on a clean machine today. It does not say the docs' code works." (We broke the install command 98 times and the monitor failed every one: 98 of 98.)
- **L2:** "A pass at L2 means the install works, the docs' code parses, and the packages it imports resolve. It does not mean the names the code uses still exist: when we renamed an imported name the monitor noticed 3 of 22 times at L2, a renamed method 0 of 18, a misnamed option 0 of 27." (There is a known gap in the syntax check for ES-module `.js` files, found by this measurement.)
- **L3:** "A pass at L3 means the snippet ran against the vendor's own client library and reached the vendor's API. It caught every renamed name we tried (5 of 5) but not a misnamed option (0 of 2), because an authentication error with a dummy key counts as a pass." (Small numbers: 5 targets at L3.)
- **In one sentence:** "We tested the monitor by breaking quickstarts on purpose: it caught every broken install command, 93% of broken code at L3 and 64% at L2, so a green L2 badge means the quickstart installs, parses and imports, not that it works."

None of this measures how often real quickstarts break. It measures what the monitor can see.
