import type { IContextLogin } from '@axiumine/koa-utils/graphQL/schema/context/IContextLogin'
import { Types } from 'mongoose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ACCESS = 'access-token'
const REFRESH = 'refresh-token'

const tryLoginAdmin = vi.fn()
const updateAdminLoginStats = vi.fn()
const setRedisLoginSessionAdmin = vi.fn()
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
const ctx = { cookies: { set: vi.fn() } } as unknown as IContextLogin
const args = { email: 'operator@marketplace.test', password: 'clear', rememberMe: false }

let log: ReturnType<typeof vi.spyOn>

describe('loginAdmin', () => {
	beforeEach(() => {
		tryLoginAdmin.mockReset()
		updateAdminLoginStats.mockReset().mockResolvedValue(undefined)
		setRedisLoginSessionAdmin.mockReset().mockResolvedValue(undefined)
		setLoginCookies.mockReset()
		captureException.mockReset()
		endSession.mockClear()
		withTransaction.mockClear()
		startSession.mockClear()
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
		expect(setRedisLoginSessionAdmin).toHaveBeenCalledExactlyOnceWith(ACCESS, REFRESH, {
			_id: _id.toString(),
			email: args.email,
			tier: 'admin'
		})
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

	it('closes the session and rethrows as an internal error when the transaction fails', async () => {
		const error = new Error('mongo down')
		tryLoginAdmin.mockRejectedValueOnce(error)

		await expect(loginAdmin.resolve(null, args, ctx)).rejects.toThrow('Internal Server Error')

		expect(captureException).toHaveBeenCalledWith(error)
		expect(log).toHaveBeenCalledExactlyOnceWith('catch', error)
		expect(setLoginCookies).not.toHaveBeenCalled()
		expect(endSession).toHaveBeenCalledTimes(1)
	})
})
