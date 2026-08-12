import { vi } from 'vitest'

/**
 * The mock harness the three login resolvers' unit suites share.
 *
 * `login`, `loginAdmin` and `loginUser` are one resolver written once per tier, so their suites
 * opened with the same forty lines three times over — which is what Qodana's DuplicatedCode
 * reported. What moves here is exactly the tier-neutral half: the two token constants, the three
 * mocks whose module path carries no tier in it, and the mongoose session, whose double mocking is
 * the only subtle part of the setup. Everything with a tier in its name — `tryLoginAdmin`,
 * `setRedisLoginSessionUser`, … — stays in its own file, next to the `vi.mock` path it stands for.
 *
 * ⚠️ Reach this from `vi.hoisted`, never from a plain import:
 *
 *     const { … } = await vi.hoisted(async () => (await import('./helpers/loginResolverMocks.mts')).loginResolverMocks())
 *
 * `vi.mock('mongoose', …)` is hoisted above the test file's own imports, and all three suites import
 * `Types` from mongoose — so the factory runs while the module body, and any plain import it would
 * read from, is still in its temporal dead zone. `vi.hoisted` is the one thing that runs earlier,
 * and its async form is what lets it reach this module at all.
 */
export function loginResolverMocks() {
	const endSession = vi.fn()
	const withTransaction = vi.fn(async (fn: () => Promise<void>) => fn())
	const startSession = vi.fn(async () => ({ withTransaction, endSession }))
	const guardPublicLogin = vi.fn()
	const setLoginCookies = vi.fn()
	const captureException = vi.fn()

	return {
		ACCESS: 'access-token',
		REFRESH: 'refresh-token',
		guardPublicLogin,
		setLoginCookies,
		captureException,
		startSession,
		withTransaction,
		endSession,

		// Only `startSession` is swapped: `Types` must stay real, so the `_id` each suite builds is a
		// genuine ObjectId rather than something that merely stringifies like one.
		mongooseWithMockedSession: async (importOriginal: <T>() => Promise<T>) => {
			const actual = await importOriginal<typeof import('mongoose')>()

			return { ...actual, default: { ...actual.default, startSession } }
		},

		/**
		 * The reset for the mocks created here, so a suite's `beforeEach` names only its own.
		 *
		 * `mockClear` for the three session mocks and `mockReset` for the rest: clearing keeps
		 * `withTransaction`'s run-the-callback implementation and `startSession`'s return value, which
		 * a reset would wipe and no test re-declares. The guard is reset *and* re-resolved for the
		 * mirror-image reason — almost every test runs past it, and a guard answering `undefined`
		 * instead of a promise fails them all at the `await`.
		 */
		resetSharedLoginMocks() {
			guardPublicLogin.mockReset().mockResolvedValue(undefined)
			setLoginCookies.mockReset()
			captureException.mockReset()
			startSession.mockClear()
			withTransaction.mockClear()
			endSession.mockClear()
		}
	}
}
