# Test quality policy — 100% coverage **and** 100% mutation score, no exceptions

This service requires **100% test coverage on every metric** — statements, branches,
functions, and lines — **and a 100% Stryker mutation score**. Both are hard gates, not targets.

They answer different questions, which is why both exist:

| Gate | Question it answers |
|---|---|
| coverage | did a test *execute* this line? |
| mutation | would a test *fail* if this line were wrong? |

100% coverage with weak assertions is the normal failure mode, and it is invisible to the
coverage number. Mutation testing is what falsifies it: Stryker rewrites `src/` one small
change at a time (`true` → `false`, a string → `""`, a block → `{}`) and re-runs the suite.
A mutant that *survives* is an edit no test noticed.

## The rule

If coverage is below 100% on any metric, the fix is one of:

1. **Add the missing tests** for the uncovered lines / branches / functions.
2. **Delete the code** if it is unreachable or dead.

If the mutation score is below 100%, the fix is one of:

1. **Strengthen the assertion** that should have caught the mutant.
2. **Delete the code** if the mutant proves the branch is dead.
3. **Document an equivalent mutant** with `// Stryker disable next-line <Mutator>: <why>` —
   only when the mutated code provably cannot behave differently on any reachable input.

**Never** lower a threshold to make a run pass. The thresholds are the specification;
red means the work is not done, not that the number is wrong.

## Where it is enforced

| Layer | File | What it does |
|---|---|---|
| Local test run | `vitest.config.mts` → `test.coverage.thresholds` | `yarn test:cov` exits non-zero if any metric < 100% |
| Local mutation run | `stryker.config.mjs` → `thresholds.break` | `yarn test:mutation` exits non-zero if the score < 100 |
| Qodana scan gate | `qodana.yaml` → `failureConditions.testCoverageThresholds` (`total`/`fresh` = 100) | `./qodana.sh` fails the scan if coverage < 100% |
| Git `pre-commit` | `.githooks/pre-commit` | blocks the commit if `yarn test:cov` **or** the Qodana scan fails |
| Git `pre-push` | `.githooks/pre-push` | blocks the push if `yarn lint:check`, `yarn test:cov`, `yarn test:mutation` **or** the Qodana scan fails |

The coverage layers read the same coverage run (vitest, v8 provider, lcov →
`coverage/lcov.info`, `all: true` over `src/**/*.mts`). Change coverage config in
`vitest.config.mts` only. Qodana has no mutation gate — `pre-push` is the only one.

Both hooks run the scan on purpose. `git merge --no-ff` never fires `pre-commit` —
git runs that hook for `git commit` only — so the merge commit, the one revision
that reaches `origin`, is the single commit no pre-commit scan ever sees. And
Qodana Cloud files each report under the branch it ran on, so a repo scanned only
at commit time never produces a `main`-tagged report to baseline against. Each hook
hands `qodana.sh` `SKIP_TESTS=1`, reusing the `coverage/lcov.info` its own coverage
step just wrote rather than letting the script regenerate it with a test run whose
failure it swallows. `SKIP_QODANA=1` skips the scan alone; the coverage and
mutation gates stay.

## Two projects, one coverage report

`vitest.config.mts` defines two projects; `yarn test:cov` runs both and aggregates coverage:

| Project | Files | Datasources | Purpose |
|---|---|---|---|
| `unit` | `test/*.test.mts` | mocked | pure logic, error paths, prod branches — fast, offline |
| `integration` | `test/integration/*.itest.mts` | **real Redis cluster + real MongoDB** | boots the server via `start()` and drives it over HTTP |

This is the **public tier**: `createServer()` mounts no authorization middleware, because
`login` / `loginAdmin` are exactly what an anonymous caller has to be able to reach. Every
request in the integration suite is therefore credential-free — no cookie, no bearer token,
no `x-introspectioncode`.

Both datasources are opened (`Promise.all([MongoDBConnect(), RedisConnect()])`): the login
resolvers read `imprenditore` / `admin` from MongoDB inside a transaction and then write the
session to Redis. `MONGODB_URI` is consequently part of `REQUIRED_ENV_VARS` here, unlike in
the two authorization services.

The integration project uses the `REDIS_*` / `MONGODB_URI` values from `.env` (loaded by the
sources' own `dotenv.config()`). It overrides only the keyspace prefix
(`REDIS_KEY=marketplaceDev:itest:publicAuthorization:`, a per-service namespace inside the
ACL-allowed `marketplaceDev:itest:` stem) and `PORT=0` (ephemeral). Run just one side with
`yarn test:unit` / `yarn test:integration`.

Consequence: the coverage gate — and therefore `pre-push` — needs both the Redis cluster and
MongoDB reachable. That is intentional: 100% here means the server was really booted and really
talked to both, not that a mock returned the expected value.

**The integration suite never writes to MongoDB.** It seeds and deletes its own Redis keys inside
the isolated namespace, and reaches MongoDB only through reads that are expected to miss (a login
with a random address that matches no `imprenditore` and no `admin`, asserted to answer
`Unauthorized`). Seeding a real account would mean writing to the dev database, satisfying its
full `$jsonSchema` validator and storing a bcrypt hash; the happy path of both login resolvers is
covered by the unit project instead.

## A note on the `graphql` realm

`vitest.config.mts` inlines `@axiumine/koa-utils` alongside `graphql` / `@apollo/server` /
`@as-integrations`, which the other services do not do. The login mutations wrap koa-utils'
`LoginAppType` in a `new GraphQLNonNull(...)`, so koa-utils has to see the *same* transformed
`graphql` copy as the sources — otherwise graphql refuses the type with "Cannot use GraphQLObjectType
… from another module or realm".

The same split explains why the error assertions in `setRedisLoginSession.test.mts`,
`login.test.mts` and `loginAdmin.test.mts` match on `.message` rather than
`instanceof GraphQLError`.

## Enabling the hook

The `pre-push` hook lives in `.githooks/` (tracked in git). It is activated by:

```bash
git config core.hooksPath .githooks
```

The `prepare` script in `package.json` runs this automatically on `yarn install`, so a
fresh clone is gated after the first install. To verify:

```bash
git config --get core.hooksPath   # -> .githooks
```

## Server boot and Sentry init are covered — do not exclude them

`src/index.mts` (Koa/Apollo wiring, routing, shutdown) and `src/instrument.mts` (Sentry
init) reach 100% through the **integration** project, which boots the real server and hits
`/public-authorization`, `/health`, and an unknown path over HTTP. They are **not**
`v8 ignore`d and must stay that way — the only `v8 ignore` block is the entrypoint tail of
`index.mts` (the `if (NODE_ENV !== 'test')` bootstrap that registers signal handlers and calls
`start()`), which cannot run under the test process without killing the worker via
`process.exit`. Every function it wires (`start`, `gracefulShutdown`, `onUnhandledRejection`,
`onUncaughtException`) is exercised directly by tests, so the ignored block contains only the
wiring, no logic.

## Node ignores the `hostname` listen option

`src/index.mts` used to call `httpServer.listen({ port: process.env.PORT, hostname: process.env.HOSTNAME }, ...)`.
`hostname` is not a `net.Server.listen()` option — Node's key is `host` — so that field was silently
dropped on every boot, verified empirically on Node v24.14.0. With no valid `host`, Node binds the
unspecified address, i.e. every interface, regardless of what `HOSTNAME` held. The server has therefore
always listened on every interface; the `HOSTNAME` env var never had any effect, in any environment,
ever.

That wide bind is the intended behaviour, not a bug to close — nginx in front terminates TLS and this
service still needs to be reachable from wherever nginx proxies from. The fix removes the dead key
instead of adding a working `host:` that would newly *restrict* the bind:

```ts
httpServer.listen(
	{
		port: process.env.PORT
		// No host: bind every interface on purpose. This used to pass a hostname key, which is not
		// a net.Server.listen option — Node ignored it and bound the unspecified address anyway, so
		// HOSTNAME never had any effect. Binding wide is the intent; the dead key only hid it.
	},
	...
)
```

`HOSTNAME` is removed everywhere it was dead in this repo: `REQUIRED_ENV_VARS` in `src/index.mts`, the
committed `env` template, and the `logListening()` banner. **All three went in the same commit**
(`beef1c7`), so this service never had a window where the banner could print an undefined host.
`git log -S'env.HOSTNAME' -- src/index.mts` returns exactly two commits — `feat: v1` adding it and
`beef1c7` removing it — and the banner at `beef1c7` already read
`` `Serving ${ENDPOINT} on port ${env.PORT} for ${env.NODE_ENV}, bound on every interface.` ``

⚠️ An earlier revision of this section, and the message of commit `73910a3`, both claimed the opposite:
that a first pass deleted `HOSTNAME` from the env template while leaving `logListening()` reading it, so
the banner printed `Serving http://undefined:<port>…` at every boot. **That is not this repo's history**
and the correction is recorded here rather than by rewriting the commit. The bug was real, but in three
*sibling* services — `public-resource`, `admin-authenticated-resource` and `authenticated-logout` — where
the two changes did land in separate commits. The instruction that produced `73910a3` assumed all seven
shared that history; four of them did not.

What `73910a3` actually did here is cosmetic: it changed the banner to
`` `Serving http://*:${env.PORT}${ENDPOINT} for ${env.NODE_ENV}.` `` so all seven services print one
wording instead of three. The server binds every interface, so there is no single address to name.

The test added alongside it is genuinely worth having, and it is worth being precise about why. It calls
`logListening()` with **no argument** against a stubbed `process.env` and asserts the exact resulting
string. That is how `start()` actually invokes it; the pre-existing tests passed an explicit
`{ NODE_ENV, HOSTNAME, PORT }` object, exercising an overload production never uses. In the three sibling
services that shape of test is precisely what let the undefined-host bug ship unnoticed. Here it caught
nothing, because there was nothing to catch — it closes the same blind spot before it can matter.

Separately, `test/index.unit.test.mts` also gained a `start (success path)` describe block that stubs
`http.Server.prototype.listen` and asserts the exact options object —
`toHaveBeenCalledExactlyOnceWith({ port: process.env.PORT }, expect.any(Function))` — so a regression
that reintroduces any host-shaped key would fail the test even though Node would still silently ignore
it at runtime.

## Mutation testing — what is mutated, and what is not

`yarn test:mutation` runs Stryker (`stryker.config.mjs`) with the **vitest** runner over
`vitest.mutation.config.mts`, which mirrors the `unit` project only — the integration project is
never pointed at Stryker: it re-runs the suite once per mutant, and hitting the real Redis cluster
and the real dev MongoDB that many times (where `fileParallelism: false` serialises everything
within this service) would be both slow and unsafe, regardless of the
`marketplaceDev:itest:publicAuthorization:` keyspace now being isolated to this service rather than
shared platform-wide. Unit tests have both datasources mocked, so mutant runs stay hermetic and
parallelisable.

| Setting | Why |
|---|---|
| runs the **`unit` project only** | as above — the integration project is never exercised under Stryker. |
| `!src/graphQLPublic/schema/types/**` | `Hello2Type.mts` is pure SDL — a field name and a scalar type, no branch to mutate meaningfully. |

### `ignoreStatic` is gone — it was hiding real, killable mutants

`stryker.config.mjs` used to set `ignoreStatic: true` on the theory that module-load literals
(`name: 'MutationsPublic'`, `name: 'QueriesPublic'`, `authPublicHello`'s `description`, `ENDPOINT`)
were structurally unkillable: the module is already in the ESM registry by the time Stryker's
active-mutant switch flips, so a top-level `const x = new GraphQLObjectType({...})` never
re-evaluates. That was a misdiagnosis, not a limitation of Stryker. Dropping the flag reintroduced
39 mutants that had been excluded wholesale (131 → 170 total). Of those, 33 were already killed
incidentally by the existing suite; the remaining 6 survived and needed real work:

- `src/graphQLPublic/schema/queries/authPublicHello.mts` — the `description: 'authPublicHello'`
  literal.
- `src/graphQLPublic/schema/mutations.mts` and `queries.mts` — the `name: '...'` string and the
  whole `new GraphQLObjectType({...})` config object, one pair each.
- `src/index.mts` — the `ENDPOINT = '/public-authorization'` literal.

The fix had two parts, because a single technique did not cover both failure shapes:

1. **`ENDPOINT`** and `authPublicHello.description` are plain values with no side effect when
   read wrong — the original bug was simply that the test asserting them never actually pinned the
   literal. `test/index.unit.test.mts` now asserts `ENDPOINT` against the hardcoded string
   `'/public-authorization'` (not derived from the same import it is checking), and
   `test/schema.test.mts` asserts `authPublicHello.description` directly.
2. **`mutations.mts`/`queries.mts`** are different: mutating their config object to `{}` makes
   `new GraphQLObjectType({})` *throw* (`"Must provide name."`) at module-evaluation time. A
   top-level `import` in `schema.test.mts` evaluates that throw during Vitest's file-collection
   phase, before any test body runs, which Stryker cannot attribute to a test — reported Survived
   even though the whole suite visibly breaks. Moving the import into a `beforeAll` was tried first
   and was **not** enough: a `beforeAll` that throws fails the entire file as one "Failed Suite"
   with every individual test reported as *skipped*, and Stryker's vitest runner still does not
   count that as a kill (verified empirically, by hand-reproducing the `{}` mutant: 9 skipped, 0
   failed). Re-importing inside a `beforeEach` — so the mutated module load, and any throw it
   causes, happens inside each individual test's own run — is what actually works (same
   hand-reproduced mutant: 9 failed, 0 skipped). `test/schema.test.mts` now imports
   `MutationsPublic`, `QueriesPublic`, `authPublicHello` and `Hello2Type` dynamically inside a
   `beforeEach`, not with a top-level `import`.

That work landed at 170/170. Afterwards, an unrelated fix (see "Node ignores the `hostname`
listen option" below) removed the dead `HOSTNAME` entry from `REQUIRED_ENV_VARS`, which removes
one more mutant (a `StringLiteral` on that array element) along with it.

Current state: **169 mutants, 169 killed, 0 survived**, ~37 s.

### index.mts is only *partially* excluded — unlike the logout service

Unlike `marketplace-dev-authenticated-logout`, this service's `test/index.unit.test.mts` unit-tests
most of `index.mts` directly: `checkRequiredEnv`, `buildValidationRules`, `healthResponse`,
`logListening`, `gracefulShutdown`, `onUnhandledRejection`, `onUncaughtException`, and both of
`start()`'s failure paths (MongoDB/Redis rejecting). A blanket file exclusion would have thrown
away mutation coverage on all of that. Instead `stryker.config.mjs` negates the whole file and
re-includes it by **line range**, verified empirically on a first Stryker run with no index.mts
exclusion at all — every mutant inside the excluded ranges reported `NoCoverage`, and none outside
them did:

| Range | Content | Why excluded |
|---|---|---|
| 106–180 | `createServer()` | Wires the real Koa app, the `ENDPOINT`/`/health` routing middleware and the real `ApolloServer`. Only `test/integration/index.itest.mts` exercises it, by actually booting the server and hitting it over HTTP. |
| 200–215 | `start()`'s happy-path continuation (`httpServer.listen`, the wrapping `Promise`, the final `return`) | Only runs once both datasources actually connect, which happens only under the integration project. `test/index.unit.test.mts`'s "start (success path)" test does exercise this span too, by stubbing `http.Server.prototype.listen` — but it is regression insurance for the `{ port }`-only shape, not a reason to bring these lines into Stryker's scope; the line range stays excluded for the same reason as always: a Stryker mutant here would only ever get `NoCoverage` from the unit project's other tests. |
| 223–241 | the `/* v8 ignore start/stop */` bootstrap tail | Guarded by `if (process.env.NODE_ENV !== 'test')` — structurally cannot execute inside any test process, unit or integration, the same reason it is `v8 ignore`d for the coverage gate. |

(Line numbers shifted from an earlier version of this table by the fix that dropped the dead
`hostname` key from `httpServer.listen()` — see below. The regions themselves are unchanged.)

Everything else in `index.mts` — including `start()`'s signature, its `try`/`Promise.all` and its
`catch` block — is mutated and killed by the unit project.

`instrument.mts` needed **no exclusion at all**: `test/instrument.test.mts` mocks `@sentry/node` and
`https` and asserts the actual behaviour (`insecureHttpsModule.request` disables TLS verification
and delegates to `https.request`), so both of its mutants are killed.

### Equivalent mutants

Five mutants are annotated in `src/graphQLPublic/schema/mutations/{login,loginAdmin}.mts` with
`// Stryker disable next-line`, each above a comment carrying the reachability argument: the
initial `''` given to `accessToken` (both resolvers) and `refreshToken` (`loginAdmin`) is always
overwritten before it is read, and the `''` reassignment in the `catch` block is never read at all,
because `tryCatchRethrow` (from `@axiumine/koa-utils`) always throws — every branch of
`throwIfMongoErr`, and both branches of the `if`/`else` after it, terminate in a `throw`. There is
no input for which either resolver reaches its `return` after entering the `catch` block, so these
values are provably unobservable on any reachable path.

Do not add to this list without the same kind of argument. "I could not think of a test" is not
an equivalence proof.

### Writing tests that kill

The two `console.log('catch', e)` calls (`login.mts`, `loginAdmin.mts`) and the one
`console.error('error', error)` call (`index.mts`, inside `start()`'s catch) were the real
survivors: both test files already spied on `console.log`/`console.error` to silence the noise, but
never asserted *what* they were called with, so a mutant that rewrote the literal to `""` passed
just as well as the original. `toHaveBeenCalledExactlyOnceWith('catch', error)` /
`toHaveBeenCalledExactlyOnceWith('error', error)` is what actually pins the call.

## Running it

```bash
yarn test:cov       # coverage + threshold check (the source of truth)
yarn test:mutation  # Stryker; report at reports/mutation/mutation.html
./qodana.sh         # full Qodana Ultimate scan, incl. the 100% coverage gate
```

`git push` runs the first two, in that order, and blocks on either.
