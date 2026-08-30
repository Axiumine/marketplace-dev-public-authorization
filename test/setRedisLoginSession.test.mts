import { IRefreshData } from '@axiumine/marketplace-common/others/IRefreshData'
import { TIER } from '@axiumine/marketplace-common/others/Tier'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const hSet = vi.fn()
const expire = vi.fn()
const hExpire = vi.fn()
const del = vi.fn()
const captureException = vi.fn()

const ACCESS_EXPIRY = 900
const REFRESH_EXPIRY = 90 * 24 * 60 * 60

vi.mock('@axiumine/koa-utils/dataSources/Redis', () => ({ redisClient: { hSet, expire, hExpire, del } }))
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
 * ⚠️ Writes have been hashed-only since E13-S01 and reads since E13-S10, when the raw-key fallback that
 * let the old shape drain was deleted. The digest is the only name a session has anywhere.
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

/**
 * One hour after the login in the fixture above, and the reason the clock is pinned below (E15-S03).
 *
 * The *field's* TTL is what is left of `originalLogin + sessionCapDays`, which for a one-day session an
 * hour old is 23 hours — and that number is the point: it is neither the key's thirty days, nor the
 * session key's ninety, nor a fresh day. All three are wrong in a way only an exact assertion catches.
 */
const AN_HOUR_AFTER_LOGIN = Number(refreshData.originalLogin) + 3_600_000
const FIELD_TTL = 86_400 - 3_600

describe('setRedisLoginSession', () => {
	beforeEach(() => {
		hSet.mockReset().mockResolvedValue(1)
		expire.mockReset().mockResolvedValue(true)
		hExpire.mockReset().mockResolvedValue([1])
		del.mockReset().mockResolvedValue(1)
		captureException.mockReset()
		// ⚠️ The field TTL is a *countdown to a deadline*, so the clock is part of the fixture. Left real,
		// the only assertion available would be a range — and a range survives a flipped sign, a floor
		// where a ceiling belongs, and a cap read off the wrong field. Pinned, the number is exact.
		vi.useFakeTimers({ toFake: ['Date'] })
		vi.setSystemTime(AN_HOUR_AFTER_LOGIN)
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	it('writes both hashes in the configured keyspace, then sets their TTLs', async () => {
		await expect(setRedisLoginSession(ACCESS, REFRESH, accessData, refreshData)).resolves.toBeUndefined()

		expect(hSet).toHaveBeenCalledWith(keyAccess, accessData)
		// ⚠️ **The refresh hash is the caller's data *plus* the key of the access token minted beside it**,
		// and the addition is the whole of E14-S06's residual. A session is a pair; until the refresh half
		// recorded the name of the other, the only thing that could find the access token was the
		// `Authorization` header of the next call — and a page reload sends none, because an access token
		// lives in memory. Asserted as the exact object, so a login that files the caller's data unchanged
		// fails here rather than three hours later as an access token nothing can revoke.
		expect(hSet).toHaveBeenCalledWith(keyRefresh, { ...refreshData, accessKey: keyAccess })
		// The stored value is a key — a digest under the shared prefix — and never the token it names.
		expect(hSet.mock.calls[1][1].accessKey).not.toContain(ACCESS)
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
		/*
		 * ⚠️ **Two TTLs on one write, and they are deliberately different numbers** (E15-S03). The key gets
		 * the longer cap so no login can pull the account's whole index down; the field gets what is left of
		 * *this* session's cap, so the row cannot outlive the session it names. Swapping them breaks the
		 * index in one direction each, and both failures are invisible until an admin reads the list.
		 */
		expect(hExpire).toHaveBeenCalledWith(keyIndex, indexField, FIELD_TTL)
		expect(indexField).toMatch(/^[0-9a-f]{64}$/)
		expect(keyIndex).not.toContain(REFRESH)
		expect(JSON.stringify(hSet.mock.calls)).not.toContain(REFRESH)
		// The whole rotation of commands, in order: both hashes, both TTLs, then the index — the field is
		// written after the session it names, and the index key's TTL after the field that creates the key.
		expect(hSet.mock.calls.map(([key]) => key)).toEqual([keyAccess, keyRefresh, keyIndex])
		expect(expire.mock.calls.map(([key]) => key)).toEqual([keyAccess, keyRefresh, keyIndex])
		expect(hExpire).toHaveBeenCalledTimes(1)
		expect(hExpire.mock.invocationCallOrder[0]).toBeGreaterThan(Math.max(...hSet.mock.invocationCallOrder))
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
