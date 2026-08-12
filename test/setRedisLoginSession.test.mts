import { IRefreshData } from '@axiumine/marketplace-common/others/IRefreshData'
import { TIER } from '@axiumine/marketplace-common/others/Tier'
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
const ID = '507f1f77bcf86cd799439011'
const accessData = { _id: ID, email: 'shop@marketplace.test' }
const refreshData: IRefreshData = {
	_id: ID,
	tier: TIER.shopOwner,
	familyId: '4b1a4a5e-0d3a-4a2f-9a5a-2f0f6a1b8c3d',
	originalLogin: '1754784000000',
	sessionCapDays: '1'
}

/*
 * The account's session index (E15-S02): one hash per account, named by tier *and* id, holding one field
 * per live session.
 *
 * ⚠️ **The field is the body of `keyRefresh`, not a lookalike.** E15-S04 rebuilds the key to revoke as
 * `${REDIS_KEY}${field}` and never sees a token, so a field digested from anything else would still be 64
 * hex characters, still pass a shape check, and name a key that does not exist — an index of sessions
 * nothing can revoke, silent until the one moment it matters.
 */
const keyIndex = `test:idx:shopOwner:${ID}`
const indexField = keyRefresh.slice('test:'.length)
/** Thirty days in seconds. A literal, so a mutated cap moves one side of the assertion and not both. */
const INDEX_TTL = 2_592_000

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

	/*
	 * E15-S02, at the site that mints every session on the platform. Four things are pinned and each is a
	 * silent failure alone: the key (tier *and* id, because three collections mint ids independently), the
	 * field (the digest the revocation rebuilds its key from), the value (a description of the session, with
	 * no token in it) and the order — the field cannot be armed before the hash it lives in exists.
	 *
	 * ⚠️ **The TTL is the longer cap and never the session's own**, which is what this fixture proves: the
	 * session written here carries `sessionCapDays: '1'` and the key still gets thirty days. Using the
	 * session's cap would let one unremembered login pull the whole key down to a day and orphan a
	 * remembered session — live, listed nowhere, and missed by E15-S04's revocation.
	 */
	it('files the session under its account, by digest, and gives the index the longer cap', async () => {
		await setRedisLoginSession(ACCESS, REFRESH, accessData, refreshData)

		expect(hSet).toHaveBeenCalledWith(keyIndex, {
			[indexField]: JSON.stringify({ tier: TIER.shopOwner, mintedAt: refreshData.originalLogin })
		})
		expect(expire).toHaveBeenCalledWith(keyIndex, INDEX_TTL)
		expect(indexField).toMatch(/^[0-9a-f]{64}$/)
		expect(keyIndex).not.toContain(REFRESH)
		expect(JSON.stringify(hSet.mock.calls)).not.toContain(REFRESH)
		// The whole rotation of commands, in order: both hashes, both TTLs, then the index — the field is
		// written after the session it names, and the index key's TTL after the field that creates the key.
		expect(hSet.mock.calls.map(([key]) => key)).toEqual([keyAccess, keyRefresh, keyIndex])
		expect(expire.mock.calls.map(([key]) => key)).toEqual([keyAccess, keyRefresh, keyIndex])
	})

	/*
	 * ⚠️ A login whose session cannot be listed is a login that cannot be revoked, so the index write is
	 * inside the try and its failure rolls the session back. The alternative — swallowing it — would mint a
	 * working session that E15-S04 can never reach, and nothing downstream would ever notice.
	 */
	it('rolls the session back when the index write fails', async () => {
		const error = new Error('index write failed')
		hSet.mockResolvedValueOnce(1).mockResolvedValueOnce(1).mockRejectedValueOnce(error)

		await expect(setRedisLoginSession(ACCESS, REFRESH, accessData, refreshData)).rejects.toThrow('Internal Server Error')

		expect(del).toHaveBeenCalledWith(keyAccess)
		expect(del).toHaveBeenCalledWith(keyRefresh)
		expect(captureException).toHaveBeenCalledWith(error)
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
