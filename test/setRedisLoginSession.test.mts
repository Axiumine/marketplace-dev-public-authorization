import { beforeEach, describe, expect, it, vi } from 'vitest'

const hSet = vi.fn()
const expire = vi.fn()
const del = vi.fn()
const captureException = vi.fn()

const ACCESS_EXPIRY = 900
const REFRESH_EXPIRY = 90 * 24 * 60 * 60

vi.mock('@axiumine/koa-utils/dataSources/Redis', () => ({ redisClient: { hSet, expire, del } }))
// accessTokenExpiry() is deliberately random in koa-utils (30–90 minutes); pinning it here keeps
// the assertion on the TTL exact instead of a range.
vi.mock('@axiumine/koa-utils/lib/tokens', () => ({
	accessTokenExpiry: () => ACCESS_EXPIRY,
	REFRESH_TOKEN_EXPIRY: REFRESH_EXPIRY
}))
vi.mock('@sentry/node', () => ({ captureException }))

const { setRedisLoginSession } = await import('../src/lib/db/redis/setRedisLoginSession.mts')

const ACCESS = 'access-token'
const REFRESH = 'refresh-token'
const keyAccess = `test:access:${ACCESS}`
const keyRefresh = `test:refresh:${REFRESH}`
const accessData = { _id: '507f1f77bcf86cd799439011', email: 'shop@marketplace.test' }
const refreshData = { _id: '507f1f77bcf86cd799439011' }

describe('setRedisLoginSession', () => {
	beforeEach(() => {
		hSet.mockReset().mockResolvedValue(1)
		expire.mockReset().mockResolvedValue(true)
		del.mockReset().mockResolvedValue(1)
		captureException.mockReset()
	})

	it('writes both hashes in the configured keyspace, then sets their TTLs', async () => {
		await expect(setRedisLoginSession(ACCESS, REFRESH, accessData, refreshData)).resolves.toBeUndefined()

		expect(hSet).toHaveBeenCalledWith(keyAccess, accessData)
		expect(hSet).toHaveBeenCalledWith(keyRefresh, refreshData)
		// The TTLs must be applied after hSet: setting them first would let hSet reset them.
		expect(expire).toHaveBeenCalledWith(keyAccess, ACCESS_EXPIRY)
		expect(expire).toHaveBeenCalledWith(keyRefresh, REFRESH_EXPIRY)
		expect(del).not.toHaveBeenCalled()
	})

	// Asserted by message, not `instanceof GraphQLError`: vitest inlines and transforms `graphql`
	// for this file while koa-utils keeps the externalized copy, so the two GraphQLError classes
	// are not the same object and an instanceof check would fail on a genuinely correct error.
	it('rolls both keys back and reports to Sentry when a hash write fails', async () => {
		const error = new Error('redis down')
		hSet.mockRejectedValueOnce(error)

		await expect(setRedisLoginSession(ACCESS, REFRESH, accessData, refreshData)).rejects.toThrow('Internal Server Error')

		expect(del).toHaveBeenCalledWith(keyAccess)
		expect(del).toHaveBeenCalledWith(keyRefresh)
		expect(captureException).toHaveBeenCalledWith(error)
	})

	// A TTL failure leaves two session keys with no expiry, which is worse than no session at all:
	// the rollback has to cover this branch too, not just the write.
	it('rolls both keys back when a TTL write fails after the hashes were stored', async () => {
		expire.mockRejectedValueOnce(new Error('expire failed'))

		await expect(setRedisLoginSession(ACCESS, REFRESH, accessData, refreshData)).rejects.toThrow('Internal Server Error')

		expect(del).toHaveBeenCalledWith(keyAccess)
		expect(del).toHaveBeenCalledWith(keyRefresh)
	})
})
