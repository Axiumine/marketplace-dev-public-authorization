import type { IContextLogin } from '@axiumine/koa-utils/graphQL/schema/context/IContextLogin'
import { Types } from 'mongoose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The tier-neutral half of the setup, shared with loginAdmin.test.mts and loginUser.test.mts. It
// comes through vi.hoisted rather than a plain import, and the helper's own comment says why.
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

// `makeOnboardingData` has no counterpart on the other two tiers: only a shop owner is walked
// through anything after logging in, so this mock stays here rather than in the shared harness.
const tryLoginShopOwner = vi.fn()
const updateLoginStats = vi.fn()
const setRedisLoginSessionShopOwner = vi.fn()
const makeOnboardingData = vi.fn()

vi.mock('mongoose', mongooseWithMockedSession)
vi.mock('@lib/access/guardPublicLogin.mjs', () => ({ guardPublicLogin }))
vi.mock('@lib/db/login/tryLoginShopOwner.mjs', () => ({ tryLoginShopOwner }))
vi.mock('@lib/db/login/updateLoginStats.mjs', () => ({ updateLoginStats }))
vi.mock('@lib/db/redis/setRedisLoginSessionShopOwner.mjs', () => ({ setRedisLoginSessionShopOwner }))
vi.mock('@axiumine/koa-utils/lib/setLoginCookies', () => ({ setLoginCookies }))
vi.mock('@axiumine/koa-utils/lib/makeOnboardingData', () => ({ makeOnboardingData }))
vi.mock('@axiumine/koa-utils/lib/tokens', () => ({
	generateAccessToken: () => ACCESS,
	generateRefreshToken: () => REFRESH
}))
vi.mock('@sentry/node', () => ({ captureException }))

const { login } = await import('../src/graphQLPublic/schema/mutations/login.mts')

const _id = new Types.ObjectId('507f1f77bcf86cd799439011')
// ⚠️ No `ip` on this fixture, and that is the point: the resolver's context parameter is
// `IContextLogin`, koa-utils' two-method view of the cookie jar, so nothing in the file can read a
// request property. The per-caller rate limit is nginx's — `app.proxy` is off, so the address this
// process sees is the proxy's own.
const ctx = { cookies: { set: vi.fn() } } as unknown as IContextLogin
const args = { email: 'shop@marketplace.test', password: 'clear', rememberMe: true, turnstileToken: 'turnstile-token' }

let log: ReturnType<typeof vi.spyOn>

describe('login', () => {
	beforeEach(() => {
		resetSharedLoginMocks()
		tryLoginShopOwner.mockReset()
		updateLoginStats.mockReset().mockResolvedValue(undefined)
		setRedisLoginSessionShopOwner.mockReset().mockResolvedValue(undefined)
		makeOnboardingData.mockReset()
		log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
	})
	afterEach(() => log.mockRestore())

	it('opens a session, stores the Redis session, updates the stats and sets the refresh cookie', async () => {
		const lastLogin = new Date('2026-01-01T00:00:00.000Z')
		tryLoginShopOwner.mockResolvedValueOnce({ _id, login: { lastLogin, onboardingDone: true } })
		makeOnboardingData.mockReturnValueOnce('personalData')

		const result = await login.resolve(null, args, ctx)

		expect(tryLoginShopOwner).toHaveBeenCalledExactlyOnceWith(args.email, args.password, { withTransaction, endSession })
		expect(setRedisLoginSessionShopOwner).toHaveBeenCalledExactlyOnceWith(
			ACCESS,
			REFRESH,
			{
				_id: _id.toString(),
				email: args.email,
				tier: 'shopOwner',
				onboardingStep: 'personalData'
			},
			true
		)
		expect(updateLoginStats).toHaveBeenCalledExactlyOnceWith(_id, lastLogin, true, { withTransaction, endSession })
		expect(setLoginCookies).toHaveBeenCalledExactlyOnceWith(ctx, REFRESH)
		expect(endSession).toHaveBeenCalledTimes(1)

		// Only the access token reaches the client: `onboardingStep` / `onboardingDone` are declared
		// in the resolver but never assigned, so the response always carries '' / false even when the
		// Redis session does hold a step. Asserted as-is — this documents current behaviour.
		expect(result).toEqual({ onboardingStep: '', onboardingDone: false, accessToken: ACCESS })
	})

	// makeOnboardingData returns null for an shopOwner that never finished onboarding; the key
	// must then be absent from the Redis hash, not present and empty.
	it('omits onboardingStep from the Redis payload and passes a null lastLogin on the first login', async () => {
		tryLoginShopOwner.mockResolvedValueOnce({ _id, login: {} })
		makeOnboardingData.mockReturnValueOnce(null)

		await login.resolve(null, args, ctx)

		expect(setRedisLoginSessionShopOwner).toHaveBeenCalledExactlyOnceWith(
			ACCESS,
			REFRESH,
			{
				_id: _id.toString(),
				email: args.email,
				tier: 'shopOwner'
			},
			true
		)
		expect(updateLoginStats).toHaveBeenCalledExactlyOnceWith(_id, null, true, expect.anything())
	})

	// The counter is worth nothing if it is spent after the work it is meant to refuse. `guardPublicLogin`
	// runs before the Mongo session and before bcrypt, so a refused caller costs one Redis INCR.
	it('refuses a rate-limited caller before opening a session or touching the database', async () => {
		guardPublicLogin.mockRejectedValueOnce(new Error('Too Many Requests'))

		await expect(login.resolve(null, args, ctx)).rejects.toThrow('Too Many Requests')

		expect(startSession).not.toHaveBeenCalled()
		expect(tryLoginShopOwner).not.toHaveBeenCalled()
		expect(setLoginCookies).not.toHaveBeenCalled()
	})

	// The limit is policy, so it is asserted rather than left to whoever edits the constant next: 60 per
	// email is set high on purpose, because anyone who knows a shop owner's address can spend that budget
	// and lock its owner out of their own back office. The per-caller half is nginx's `mkt_owner_auth`.
	it('meters on the login bucket at 60 per email, with a normalised address', async () => {
		tryLoginShopOwner.mockResolvedValueOnce({ _id, login: {} })
		makeOnboardingData.mockReturnValueOnce(null)

		await login.resolve(null, { ...args, email: '  Shop@Marketplace.TEST  ' }, ctx)

		expect(guardPublicLogin).toHaveBeenCalledExactlyOnceWith({
			bucket: 'login',
			email: 'shop@marketplace.test',
			turnstileToken: args.turnstileToken,
			perEmailPerHour: 60
		})
	})

	// The argument is nullable and the gate still holds: `assertTurnstile` verifies a token only when the
	// process holds a secret of its own, so a request with no token is refused exactly where it should be
	// — in a deployment that has the secret — and waved through on a developer box that does not.
	it('passes an absent turnstileToken through rather than substituting one', async () => {
		tryLoginShopOwner.mockResolvedValueOnce({ _id, login: {} })
		makeOnboardingData.mockReturnValueOnce(null)

		await login.resolve(null, { email: args.email, password: args.password, rememberMe: true }, ctx)

		expect(guardPublicLogin).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ turnstileToken: undefined }))
	})

	it('closes the session and rethrows as an internal error when the transaction fails', async () => {
		const error = new Error('mongo down')
		tryLoginShopOwner.mockRejectedValueOnce(error)

		await expect(login.resolve(null, args, ctx)).rejects.toThrow('Internal Server Error')

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
