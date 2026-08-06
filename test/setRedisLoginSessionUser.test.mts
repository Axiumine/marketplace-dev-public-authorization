import { beforeEach, describe, expect, it, vi } from 'vitest'

const setRedisLoginSession = vi.fn()

vi.mock('@lib/db/redis/setRedisLoginSession.mjs', () => ({ setRedisLoginSession }))

const { setRedisLoginSessionUser } = await import('../src/lib/db/redis/setRedisLoginSessionUser.mts')

describe('setRedisLoginSessionUser', () => {
	beforeEach(() => setRedisLoginSession.mockReset())

	// Same split as the other two tiers: the access hash carries everything the resource service reads,
	// the refresh hash only the _id and the tier. The tier is the half that matters here — `refresh`
	// mints a new access session out of this hash, and a refresh hash without it produces a session
	// every resource service's `assertTier` rejects.
	it('stores the full payload on the access key and only the _id and tier on the refresh key', async () => {
		const accessTokenRedisData = {
			_id: '507f1f77bcf86cd799439011',
			email: 'customer@marketplace.test',
			tier: 'user' as const
		}

		await setRedisLoginSessionUser('access-token', 'refresh-token', accessTokenRedisData)

		expect(setRedisLoginSession).toHaveBeenCalledExactlyOnceWith('access-token', 'refresh-token', accessTokenRedisData, {
			_id: accessTokenRedisData._id,
			tier: 'user'
		})
	})
})
