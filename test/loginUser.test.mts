import type { IContextLogin } from '@axiumine/koa-utils/graphQL/schema/context/IContextLogin'
import { Types } from 'mongoose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ACCESS = 'access-token'
const REFRESH = 'refresh-token'

const guardPublicLogin = vi.fn()
const tryLoginUser = vi.fn()
const updateUserLoginStats = vi.fn()
const setRedisLoginSessionUser = vi.fn()
const setLoginCookies = vi.fn()
const captureException = vi.fn()

// vi.hoisted, because vi.mock('mongoose') is hoisted above these declarations and this file
// itself imports Types from mongoose — the factory therefore runs before the module body.
const { startSession, withTransaction, endSession } = vi.hoisted(() => {
	const end = vi.fn()
	const inTransaction = vi.fn(async (fn: () => Promise<void>) => fn())
	return {
		startSession: vi.fn(async () => ({ withTransaction: inTransaction, endSession: end })),
		withTransaction: inTransaction,
		endSession: end
	}
})

// Only startSession is swapped: Types must stay real so the _id below is a genuine ObjectId.
vi.mock('mongoose', async (importOriginal) => {
	const actual = await importOriginal<typeof import('mongoose')>()
	return { ...actual, default: { ...actual.default, startSession } }
})
vi.mock('@lib/access/guardPublicLogin.mjs', () => ({ guardPublicLogin }))
vi.mock('@lib/db/login/tryLoginUser.mjs', () => ({ tryLoginUser }))
vi.mock('@lib/db/login/updateUserLoginStats.mjs', () => ({ updateUserLoginStats }))
vi.mock('@lib/db/redis/setRedisLoginSessionUser.mjs', () => ({ setRedisLoginSessionUser }))
vi.mock('@axiumine/koa-utils/lib/setLoginCookies', () => ({ setLoginCookies }))
vi.mock('@axiumine/koa-utils/lib/tokens', () => ({
	generateAccessToken: () => ACCESS,
	generateRefreshToken: () => REFRESH
}))
vi.mock('@sentry/node', () => ({ captureException }))

const { loginUser } = await import('../src/graphQLPublic/schema/mutations/loginUser.mts')

const _id = new Types.ObjectId('507f1f77bcf86cd799439011')
// ⚠️ No `ip` on this fixture, and that is the point: the resolver's context parameter is
// `IContextLogin`, koa-utils' two-method view of the cookie jar, so nothing in the file can read a
// request property. The per-caller rate limit is nginx's — `app.proxy` is off, so the address this
// process sees is the proxy's own.
const ctx = { cookies: { set: vi.fn() } } as unknown as IContextLogin
const args = {
	email: 'customer@marketplace.test',
	password: 'clear',
	rememberMe: true,
	turnstileToken: 'turnstile-token'
}

let log: ReturnType<typeof vi.spyOn>

describe('loginUser', () => {
	beforeEach(() => {
		guardPublicLogin.mockReset().mockResolvedValue(undefined)
		tryLoginUser.mockReset()
		updateUserLoginStats.mockReset().mockResolvedValue(undefined)
		setRedisLoginSessionUser.mockReset().mockResolvedValue(undefined)
		setLoginCookies.mockReset()
		captureException.mockReset()
		endSession.mockClear()
		withTransaction.mockClear()
		startSession.mockClear()
		log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
	})
	afterEach(() => log.mockRestore())

	it('opens a session, stores the Redis session, updates the stats and sets the refresh cookie', async () => {
		const lastLogin = new Date('2026-01-01T00:00:00.000Z')
		tryLoginUser.mockResolvedValueOnce({ _id, login: { lastLogin } })

		const result = await loginUser.resolve(null, args, ctx)

		expect(tryLoginUser).toHaveBeenCalledExactlyOnceWith(args.email, args.password, { withTransaction, endSession })
		// tier: 'user' is the whole point of a third resolver — the session hash goes to the shared
		// REDIS_KEY prefix, and this field is what keeps the token out of the other two tiers' APIs.
		expect(setRedisLoginSessionUser).toHaveBeenCalledExactlyOnceWith(
			ACCESS,
			REFRESH,
			{
				_id: _id.toString(),
				email: args.email,
				tier: 'user'
			},
			args.rememberMe
		)
		expect(updateUserLoginStats).toHaveBeenCalledExactlyOnceWith(_id, lastLogin, true, { withTransaction, endSession })
		expect(setLoginCookies).toHaveBeenCalledExactlyOnceWith(ctx, REFRESH)
		expect(endSession).toHaveBeenCalledTimes(1)

		// No onboarding half here, unlike `login`: a customer is walked through nothing after
		// registering, so the response is the access token and nothing else.
		expect(result).toEqual({ accessToken: ACCESS })
	})

	// The counter is worth nothing if it is spent after the work it is meant to refuse. `guardPublicLogin`
	// runs before the Mongo session and before bcrypt, so a refused caller costs one Redis INCR.
	it('refuses a rate-limited caller before opening a session or touching the database', async () => {
		guardPublicLogin.mockRejectedValueOnce(new Error('Too Many Requests'))

		await expect(loginUser.resolve(null, args, ctx)).rejects.toThrow('Too Many Requests')

		expect(startSession).not.toHaveBeenCalled()
		expect(tryLoginUser).not.toHaveBeenCalled()
		expect(setLoginCookies).not.toHaveBeenCalled()
	})

	// The limit is policy, so it is asserted rather than left to whoever edits the constant next: 60 per
	// email is set high on purpose, because anyone who knows an address can spend that budget and lock its
	// owner out. The per-caller half is nginx's `mkt_auth`.
	it('meters on the loginUser bucket at 60 per email, with a normalised address', async () => {
		tryLoginUser.mockResolvedValueOnce({ _id, login: {} })

		await loginUser.resolve(null, { ...args, email: '  Customer@Marketplace.TEST  ' }, ctx)

		expect(guardPublicLogin).toHaveBeenCalledExactlyOnceWith({
			bucket: 'loginUser',
			email: 'customer@marketplace.test',
			turnstileToken: args.turnstileToken,
			perEmailPerHour: 60
		})
	})

	it('passes a null lastLogin through on the first login', async () => {
		tryLoginUser.mockResolvedValueOnce({ _id, login: {} })

		await loginUser.resolve(null, args, ctx)

		expect(updateUserLoginStats).toHaveBeenCalledExactlyOnceWith(_id, null, true, expect.anything())
	})

	it('closes the session and rethrows as an internal error when the transaction fails', async () => {
		const error = new Error('mongo down')
		tryLoginUser.mockRejectedValueOnce(error)

		await expect(loginUser.resolve(null, args, ctx)).rejects.toThrow('Internal Server Error')

		expect(captureException).toHaveBeenCalledWith(error)
		// ⚠️ And nothing is printed. This resolver was the only one of the three that never printed; since
		// E12-S20 `login.mts` and `loginAdmin.mts` match it and assert the same absence. A login failure
		// carries an email address and reaches stdout on a public service, so the absence is asserted
		// rather than merely unasserted, and the day somebody adds a debug print here the test says so.
		expect(log).not.toHaveBeenCalled()
		expect(setLoginCookies).not.toHaveBeenCalled()
		expect(endSession).toHaveBeenCalledTimes(1)
	})
})
