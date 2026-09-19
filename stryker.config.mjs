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
		'!src/graphQLPublic/schema/types/**'
		// ⚠️ index.mts is mutated in full, and that is a deliberate change of policy. It used to be
		// excluded wholesale and re-included as three hand-written LINE RANGES, on the theory that
		// createServer()'s routing middleware and start()'s happy path were reachable only from the
		// integration project — which Stryker never runs (see vitest.mutation.config.mts). Neither half
		// of that theory survives: test/index.unit.test.mts now boots the assembled server on an
		// ephemeral port and drives ENDPOINT, /health and an unknown path over a real socket, and it
		// drives start() to a successful listen, so the unit project alone covers every statement,
		// branch and function of the file.
		//
		// The ranges had meanwhile rotted exactly as their own warning said they would. The file grew
		// from 294 lines to 437 and nobody re-derived them, so gracefulShutdown, both process handlers
		// and most of start() quietly stopped being mutated at all — while the score stayed at 100 and
		// said nothing. A line range is only ever as good as the last person who remembered to move it;
		// a span that really is unreachable from the unit project should fail the run as NoCoverage,
		// not disappear from it.
		//
		// The one genuinely unreachable span — the `if (process.env.NODE_ENV !== 'test')` entrypoint
		// tail — is carved out in the source instead, by a `// Stryker disable all` / `// Stryker
		// restore all` pair around it, where it moves with the code it guards. Same shape, and the same
		// reason, as marketplace-dev-admin-authenticated-resource.
	]
}
