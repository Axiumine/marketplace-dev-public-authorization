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
/*
 * Where a session is written since E13-S01: the shared prefix plus the SHA-256 of the **prefixed** token.
 * The prefixes are inside the digest, not beside it — `access:` and `refresh:` are what tell the two hashes
 * apart, and hashing the bare uuid would mint a session no reader on the platform can find.
 *
 * The digests are written out as literals, computed elsewhere: a test that hashed the token with the call
 * the implementation makes would agree with it about any algorithm, including a mutated one.
 *
 * ⚠️ Writes are hashed-only from this deploy. Only *reads* carry the raw-key fallback (E13-S02), which is
 * what lets the old shape drain instead of being topped up.
 */
const keyAccess = 'test:69eb6f4779efa55f78ab95003c760ddb3a0ffd99289f3bc73b4a0dff19c457f4'
const keyRefresh = 'test:84c22fb18c900ef797d5ffefc61416ba5f1a10a903edb71aaad31991e16fe314'
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
		// ⚠️ Neither token survives in a key name. This is the whole of E13-S01 at the site that mints
		// every session on the platform, and it fails on any reconstruction of the old shape.
		expect(keyAccess).not.toContain(ACCESS)
		expect(keyRefresh).not.toContain(REFRESH)
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
