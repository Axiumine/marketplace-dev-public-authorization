/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
	testRunner: 'vitest',
	vitest: {
		configFile: 'vitest.mutation.config.mts'
	},
	coverageAnalysis: 'perTest',
	// `ignoreStatic` used to be set here on the theory that module-load literals
	// (`name: 'MutationsPublic'`, `name: 'QueriesPublic'`) were unkillable: a mutant
	// there was seen as Survived even though test/schema.test.mts asserts
	// `MutationsPublic.name === 'MutationsPublic'`. That was a misdiagnosis. The test
	// file imported the module under test with a top-level `import`, so the mutant fired
	// during Vitest's file-collection phase, before any test body ran — Stryker has
	// nothing to attribute the (very real) failure to, and reports Survived. Moving the
	// import into a `beforeAll` was not enough by itself: a `beforeAll` that throws (as
	// `new GraphQLObjectType({})` does once its `name`/`fields` are wiped) fails the whole
	// file as one "Failed Suite" with every test reported skipped rather than failed, and
	// Stryker's vitest runner still does not count that as a kill — verified empirically
	// by hand-reproducing that exact mutant. Re-importing inside `beforeEach` instead, so
	// the mutated read (and any throw it causes) happens inside each individual test's own
	// run, is what actually attributes the kill. With that done, every static/module-load
	// mutant here is killed with `ignoreStatic` off.
	reporters: ['clear-text', 'progress', 'html'],
	/**
	 * 28 workers on a 32-thread box. The `4` this replaces was never measured anywhere — the same literal
	 * sat in all nine Stryker configs on the platform, frontend included, where dropping it
	 * cut 59 minutes to 18.
	 *
	 * Measured here, 174 mutants, machine otherwise idle:
	 *
	 *   concurrency 4  → 38s
	 *   concurrency 28 → 36s
	 *
	 * Near enough to a tie, and kept anyway: at this size the run is all fixed cost — sandbox
	 * creation, vitest boot, the dry run — so the extra workers neither help nor hurt. Uniform across
	 * the platform beats a per-repo number that measures nothing.
	 *
	 * ⚠️ "It still scored 100" is **not** what justified this, and must not justify the next change. A
	 * starved worker misses a deadline, its test fails, and Stryker records the mutant as *killed* —
	 * overload inflates the score, so 100 at any concurrency is consistent with a gate that has quietly
	 * stopped checking. At the break threshold there is no headroom for the number to show it.
	 *
	 * What was compared instead is the set of non-killed mutants, where load surfaces first: both runs
	 * ended on the same 5 Ignored, the same files, lines and mutators — identical sets, not equal
	 * counts.
	 * Re-measure that way before touching this.
	 */
	concurrency: 28,
	timeoutMS: 60000,
	// Mutation score is a push gate — see COVERAGE.md. `break` fails the run (exit 1)
	// below this score, which is what the pre-push hook keys off. Raise it as tests
	// improve; never lower it to make a run pass.
	thresholds: { high: 100, low: 95, break: 100 },
	/**
	 * Scan and coverage output, copied into the sandbox for no reason. Stryker's always-ignored list
	 * covers only `node_modules`, `.git`, `/reports`, `*.tsbuildinfo`, `/stryker.log` and `.stryker-tmp`
	 * — `ignorePatterns` itself defaults to empty, and `.qodana/` here runs to tens of megabytes.
	 *
	 * It is not only wasted copying. `disableTypeChecks: true` resolves to the glob
	 * `**\/*.{js,ts,jsx,tsx,html,vue,mjs,mts,cts,cjs}` matched with `dot: true`, so it descends into
	 * dotted directories, and every run logged a `ParseError` trying to strip `@ts-` directives out of
	 * Qodana's own `thirdPartySoftwareList.html`. Stryker swallows that error and carries on, so the
	 * gate stayed green while printing a stack trace nobody could act on.
	 *
	 * Neither directory is an input to any test: both are gitignored build output.
	 */
	ignorePatterns: ['.qodana', 'coverage'],
	mutate: [
		'src/**/*.mts',
		// GraphQL type declarations: pure SDL (Hello2Type), no branches — nothing to mutate
		// meaningfully.
		'!src/graphQLPublic/schema/types/**',
		// index.mts is NOT excluded wholesale, unlike the logout service: test/index.unit.test.mts
		// unit-tests most of it directly (checkRequiredEnv, buildValidationRules, healthResponse,
		// logListening, gracefulShutdown, onUnhandledRejection, onUncaughtException, and start()'s
		// two failure paths), so those mutants are fully mutated below. Only the genuinely
		// integration-only spans are carved back out by line range — verified empirically on a
		// first Stryker run with no index.mts exclusion at all: every mutant inside these three
		// ranges reported NoCoverage, and none outside them did.
		'!src/index.mts',
		// ⚠️ These are LINE NUMBERS, and they do not move when the file does. Adding anything above
		// createServer() slides its body into a range marked "in scope", and the mutants that land
		// there have no unit test to kill them — the run drops off 100 with survivors nobody
		// introduced. That is exactly what ADR-029's `await setupFieldEncryption()` did. Re-derive
		// all three boundaries from the source whenever src/index.mts changes length.
		// 1) top of file through onUncaughtException, just before createServer()'s JSDoc: fully
		//    unit-tested.
		'src/index.mts:1-119',
		// 2) createServer() itself (120-211) is deliberately skipped: it wires the real Koa app,
		//    the ENDPOINT/`/health` routing middleware and the real ApolloServer, which
		//    test/integration/index.itest.mts exercises by actually booting the server and hitting
		//    it over HTTP (see COVERAGE.md, "Server boot ... are covered" — via the integration
		//    project, which Stryker never runs; see vitest.mutation.config.mts). start()'s
		//    signature through the DB-connect try/Promise.all is unit-tested (the two "start
		//    (failure path)" tests reject MongoDBConnect/RedisConnect before createServer() is
		//    ever reached), so it is re-included here. Since ADR-034 the span also carries the
		//    loadKeygrip call, which is unit-tested on both arms — mocked to resolve in the boot-order
		//    tests, mocked to reject in the third failure-path test.
		'src/index.mts:212-248',
		// 3) 249-268 is skipped: the happy-path continuation of start() (httpServer.listen, the
		//    wrapping Promise, the final `return`) only runs once both datasources actually
		//    connect, which happens only under the integration project. start()'s catch block
		//    (269-274) is unit-tested (all three failure-path tests reach it), so it is re-included.
		'src/index.mts:269-274'
		// 4) 276-294 (the `/* v8 ignore start/stop */` bootstrap tail) stays out: it is guarded by
		//    `if (process.env.NODE_ENV !== 'test')`, so it structurally cannot execute inside any
		//    test process, unit or integration — the same reason it is v8-ignored for the coverage
		//    gate instead of test-covered.
	]
}
