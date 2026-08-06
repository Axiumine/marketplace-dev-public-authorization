import { beforeEach, describe, expect, it, vi } from 'vitest'

const setRedisLoginSession = vi.fn()

vi.mock('@lib/db/redis/setRedisLoginSession.mjs', () => ({ setRedisLoginSession }))

const { setRedisLoginSessionAdmin } = await import('../src/lib/db/redis/setRedisLoginSessionAdmin.mts')

describe('setRedisLoginSessionAdmin', () => {
	beforeEach(() => setRedisLoginSession.mockReset())

	// Same split as the shopOwner tier — only the _id and the tier survive on the refresh key — but
	// the admin payload has no onboarding data to carry.
	it('stores the full payload on the access key and only the _id and tier on the refresh key', async () => {
		const accessTokenRedisData = {
			_id: '507f1f77bcf86cd799439011',
			email: 'operator@marketplace.test',
			tier: 'admin' as const
		}

		await setRedisLoginSessionAdmin('access-token', 'refresh-token', accessTokenRedisData)

		expect(setRedisLoginSession).toHaveBeenCalledExactlyOnceWith('access-token', 'refresh-token', accessTokenRedisData, {
			_id: accessTokenRedisData._id,
			tier: 'admin'
		})
	})
})
