import { beforeEach, describe, expect, it, vi } from 'vitest'

const setRedisLoginSession = vi.fn()

vi.mock('@lib/db/redis/setRedisLoginSession.mjs', () => ({ setRedisLoginSession }))

const { setRedisLoginSessionShopOwner } = await import('../src/lib/db/redis/setRedisLoginSessionShopOwner.mts')

describe('setRedisLoginSessionShopOwner', () => {
	beforeEach(() => setRedisLoginSession.mockReset())

	// The refresh hash deliberately carries only the _id: everything else (email, onboarding step)
	// belongs to the short-lived access session and must not survive a refresh.
	it('stores the full payload on the access key and only the _id on the refresh key', async () => {
		const accessTokenRedisData = {
			_id: '507f1f77bcf86cd799439011',
			email: 'shop@marketplace.test',
			onboardingStep: 'personalData'
		}

		await setRedisLoginSessionShopOwner('access-token', 'refresh-token', accessTokenRedisData)

		expect(setRedisLoginSession).toHaveBeenCalledExactlyOnceWith('access-token', 'refresh-token', accessTokenRedisData, {
			_id: accessTokenRedisData._id
		})
	})
})
