import type { IContextLogin } from '@axiumine/koa-utils/graphQL/schema/context/IContextLogin'
import { Types } from 'mongoose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ACCESS = 'access-token'
const REFRESH = 'refresh-token'

const tryLoginShopOwner = vi.fn()
const updateLoginStats = vi.fn()
const setRedisLoginSessionShopOwner = vi.fn()
const setLoginCookies = vi.fn()
const makeOnboardingData = vi.fn()
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
const ctx = { cookies: { set: vi.fn() } } as unknown as IContextLogin
const args = { email: 'shop@marketplace.test', password: 'clear', rememberMe: true }

let log: ReturnType<typeof vi.spyOn>

describe('login', () => {
	beforeEach(() => {
		tryLoginShopOwner.mockReset()
		updateLoginStats.mockReset().mockResolvedValue(undefined)
		setRedisLoginSessionShopOwner.mockReset().mockResolvedValue(undefined)
		setLoginCookies.mockReset()
		makeOnboardingData.mockReset()
		captureException.mockReset()
		endSession.mockClear()
		withTransaction.mockClear()
		startSession.mockClear()
		log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
	})
	afterEach(() => log.mockRestore())

	it('opens a session, stores the Redis session, updates the stats and sets the refresh cookie', async () => {
		const lastLogin = new Date('2026-01-01T00:00:00.000Z')
		tryLoginShopOwner.mockResolvedValueOnce({ _id, login: { lastLogin, onboardingDone: true } })
		makeOnboardingData.mockReturnValueOnce('personalData')

		const result = await login.resolve(null, args, ctx)

		expect(tryLoginShopOwner).toHaveBeenCalledExactlyOnceWith(args.email, args.password, { withTransaction, endSession })
		expect(setRedisLoginSessionShopOwner).toHaveBeenCalledExactlyOnceWith(ACCESS, REFRESH, {
			_id: _id.toString(),
			email: args.email,
			onboardingStep: 'personalData'
		})
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

		expect(setRedisLoginSessionShopOwner).toHaveBeenCalledExactlyOnceWith(ACCESS, REFRESH, {
			_id: _id.toString(),
			email: args.email
		})
		expect(updateLoginStats).toHaveBeenCalledExactlyOnceWith(_id, null, true, expect.anything())
	})

	it('closes the session and rethrows as an internal error when the transaction fails', async () => {
		const error = new Error('mongo down')
		tryLoginShopOwner.mockRejectedValueOnce(error)

		await expect(login.resolve(null, args, ctx)).rejects.toThrow('Internal Server Error')

		expect(captureException).toHaveBeenCalledWith(error)
		expect(log).toHaveBeenCalledExactlyOnceWith('catch', error)
		expect(setLoginCookies).not.toHaveBeenCalled()
		expect(endSession).toHaveBeenCalledTimes(1)
	})
})
