// noinspection DuplicatedCode -- the fragment this shares with loginUser.test.mts is the three imports and
// the `vi.hoisted` destructure under them. What that block pulls in is already shared: the setup itself
// lives in test/helpers/loginResolverMocks.mts, and this is only the binding that puts its names in scope.
// The binding cannot move — `vi.hoisted` is hoisted to the top of the file that declares it, so a file that
// imported these names instead would not have them by the time its `vi.mock` factories run.

import type { IContextLogin } from '@axiumine/koa-utils/graphQL/schema/context/IContextLogin'
import { Types } from 'mongoose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The tier-neutral half of the setup, shared with login.test.mts and loginUser.test.mts. It comes
// through vi.hoisted rather than a plain import, and the helper's own comment says why.
const {
	ACCESS,
	REFRESH,
	guardPublicLogin,
	setLoginCookies,
	captureException,
	startSession,
	withTransaction,
	endSession,
	mongooseWithMockedSession,
	resetSharedLoginMocks
} = await vi.hoisted(async () => (await import('./helpers/loginResolverMocks.mts')).loginResolverMocks())

const tryLoginAdmin = vi.fn()
const updateAdminLoginStats = vi.fn()
const setRedisLoginSessionAdmin = vi.fn()

vi.mock('mongoose', mongooseWithMockedSession)
vi.mock('@lib/access/guardPublicLogin.mjs', () => ({ guardPublicLogin }))
vi.mock('@lib/db/login/tryLoginAdmin.mjs', () => ({ tryLoginAdmin }))
vi.mock('@lib/db/login/updateAdminLoginStats.mjs', () => ({ updateAdminLoginStats }))
vi.mock('@lib/db/redis/setRedisLoginSessionAdmin.mjs', () => ({ setRedisLoginSessionAdmin }))
vi.mock('@axiumine/koa-utils/lib/setLoginCookies', () => ({ setLoginCookies }))
vi.mock('@axiumine/koa-utils/lib/tokens', () => ({
	generateAccessToken: () => ACCESS,
	generateRefreshToken: () => REFRESH
}))
vi.mock('@sentry/node', () => ({ captureException }))

const { loginAdmin } = await import('../src/graphQLPublic/schema/mutations/loginAdmin.mts')

const _id = new Types.ObjectId('507f1f77bcf86cd799439011')
// ⚠️ No `ip` on this fixture, and that is the point: the resolver's context parameter is
// `IContextLogin`, koa-utils' two-method view of the cookie jar, so nothing in the file can read a
// request property. The per-caller rate limit is nginx's — `app.proxy` is off, so the address this
// process sees is the proxy's own.
const ctx = { cookies: { set: vi.fn() } } as unknown as IContextLogin
const args = { email: 'operator@marketplace.test', password: 'clear', rememberMe: false, turnstileToken: 'turnstile-token' }

let log: ReturnType<typeof vi.spyOn>

describe('loginAdmin', () => {
	beforeEach(() => {
		resetSharedLoginMocks()
		tryLoginAdmin.mockReset()
		updateAdminLoginStats.mockReset().mockResolvedValue(undefined)
		setRedisLoginSessionAdmin.mockReset().mockResolvedValue(undefined)
		log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
	})
	afterEach(() => log.mockRestore())

	// No onboarding here, unlike the shopOwner tier: an Admin is created by the platform
	// operator and is done by definition, so the response pins onboardingDone to true.
	it('opens a session, stores the Redis session, updates the stats and sets the refresh cookie', async () => {
		const lastLogin = new Date('2026-01-01T00:00:00.000Z')
		tryLoginAdmin.mockResolvedValueOnce({ _id, login: { lastLogin } })

		const result = await loginAdmin.resolve(null, args, ctx)

		expect(tryLoginAdmin).toHaveBeenCalledExactlyOnceWith(args.email, args.password, { withTransaction, endSession })
		expect(setRedisLoginSessionAdmin).toHaveBeenCalledExactlyOnceWith(
			ACCESS,
			REFRESH,
			{
				_id: _id.toString(),
				email: args.email,
				tier: 'admin'
			},
			args.rememberMe
		)
		expect(updateAdminLoginStats).toHaveBeenCalledExactlyOnceWith(_id, lastLogin, false, { withTransaction, endSession })
		expect(setLoginCookies).toHaveBeenCalledExactlyOnceWith(ctx, REFRESH)
		expect(endSession).toHaveBeenCalledTimes(1)
		expect(result).toEqual({ accessToken: ACCESS, onboardingStep: '', onboardingDone: true })
	})

	it('passes a null lastLogin on the very first login', async () => {
		tryLoginAdmin.mockResolvedValueOnce({ _id, login: {} })

		await loginAdmin.resolve(null, args, ctx)

		expect(updateAdminLoginStats).toHaveBeenCalledExactlyOnceWith(_id, null, false, expect.anything())
	})

	// The counter is worth nothing if it is spent after the work it is meant to refuse. `guardPublicLogin`
	// runs before the Mongo session and before bcrypt, so a refused caller costs one Redis INCR.
	it('refuses a rate-limited caller before opening a session or touching the database', async () => {
		guardPublicLogin.mockRejectedValueOnce(new Error('Too Many Requests'))

		await expect(loginAdmin.resolve(null, args, ctx)).rejects.toThrow('Too Many Requests')

		expect(startSession).not.toHaveBeenCalled()
		expect(tryLoginAdmin).not.toHaveBeenCalled()
		expect(setLoginCookies).not.toHaveBeenCalled()
	})

	// The limit is policy, so it is asserted rather than left to whoever edits the constant next, and it is
	// the tightest of the three tiers on purpose: a handful of operator accounts sign in from a handful of
	// places, and a stolen operator session is the worst outcome on the platform.
	it('meters on the loginAdmin bucket at 30 per email, with a normalised address', async () => {
		tryLoginAdmin.mockResolvedValueOnce({ _id, login: {} })

		await loginAdmin.resolve(null, { ...args, email: '  Operator@Marketplace.TEST  ' }, ctx)

		expect(guardPublicLogin).toHaveBeenCalledExactlyOnceWith({
			bucket: 'loginAdmin',
			email: 'operator@marketplace.test',
			turnstileToken: args.turnstileToken,
			perEmailPerHour: 30
		})
	})

	// The argument is nullable and the gate still holds: `assertTurnstile` verifies a token only when the
	// process holds a secret of its own, so a request with no token is refused exactly where it should be
	// — in a deployment that has the secret — and waved through on a developer box that does not.
	it('passes an absent turnstileToken through rather than substituting one', async () => {
		tryLoginAdmin.mockResolvedValueOnce({ _id, login: {} })

		await loginAdmin.resolve(null, { email: args.email, password: args.password, rememberMe: false }, ctx)

		expect(guardPublicLogin).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ turnstileToken: undefined }))
	})

	it('closes the session and rethrows as an internal error when the transaction fails', async () => {
		const error = new Error('mongo down')
		tryLoginAdmin.mockRejectedValueOnce(error)

		await expect(loginAdmin.resolve(null, args, ctx)).rejects.toThrow('Internal Server Error')

		expect(captureException).toHaveBeenCalledWith(error)
		// ⚠️ E12-S20. This block used to open with `console.log('catch', e)` and this line used to assert
		// it. A login failure has the caller's email address in scope and stdout is a log file, so the
		// absence is asserted rather than merely unasserted — the day somebody puts the print back while
		// debugging, the test says so. `loginUser.mts` has always been this way round.
		expect(log).not.toHaveBeenCalled()
		expect(setLoginCookies).not.toHaveBeenCalled()
		expect(endSession).toHaveBeenCalledTimes(1)
	})
})
