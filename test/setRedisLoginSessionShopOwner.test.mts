import { beforeEach, describe, expect, it, vi } from 'vitest'

const setRedisLoginSession = vi.fn()

vi.mock('@lib/db/redis/setRedisLoginSession.mjs', () => ({ setRedisLoginSession }))

const { setRedisLoginSessionShopOwner } = await import('../src/lib/db/redis/setRedisLoginSessionShopOwner.mts')

describe('setRedisLoginSessionShopOwner', () => {
	beforeEach(() => setRedisLoginSession.mockReset())

	// The refresh hash deliberately carries only the _id and the tier: everything else (email,
	// onboarding step) belongs to the short-lived access session and must not survive a refresh.
	// The tier is the exception because `refresh` mints a new access session out of this hash and
	// would otherwise have to guess which collection the session belongs to.
	it('stores the full payload on the access key and only the _id and tier on the refresh key', async () => {
		const accessTokenRedisData = {
			_id: '507f1f77bcf86cd799439011',
			email: 'shop@marketplace.test',
			tier: 'shopOwner' as const,
			onboardingStep: 'personalData'
		}

		await setRedisLoginSessionShopOwner('access-token', 'refresh-token', accessTokenRedisData)

		expect(setRedisLoginSession).toHaveBeenCalledExactlyOnceWith('access-token', 'refresh-token', accessTokenRedisData, {
			_id: accessTokenRedisData._id,
			tier: 'shopOwner'
		})
	})
})
