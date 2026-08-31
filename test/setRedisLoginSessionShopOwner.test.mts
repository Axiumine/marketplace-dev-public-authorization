import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const setRedisLoginSession = vi.fn()

vi.mock('@lib/db/redis/setRedisLoginSession.mjs', () => ({ setRedisLoginSession }))

const { setRedisLoginSessionShopOwner } = await import('../src/lib/db/redis/setRedisLoginSessionShopOwner.mts')

const NOW = 1_754_784_000_000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('setRedisLoginSessionShopOwner', () => {
	const accessTokenRedisData = {
		_id: '507f1f77bcf86cd799439011',
		email: 'shop@marketplace.test',
		onboardingStep: 'personalData' as const,
		tier: 'shopOwner' as const
	}

	beforeEach(() => {
		setRedisLoginSession.mockReset()
		vi.useFakeTimers({ toFake: ['Date'] })
		vi.setSystemTime(NOW)
	})

	afterEach(() => vi.useRealTimers())

	/*
	 * ⚠️ **The onboarding step stays off the refresh key.** It is read by the SPA on every request and it
	 * changes as the shop owner completes the wizard, so a copy on a key that lives ninety days would go
	 * stale and answer questions nobody asked it.
	 *
	 * Both hashes are asserted whole rather than by subset: a writer that dropped one lineage
	 * field would mint sessions `assertRefreshLineage` refuses on their first rotation.
	 */
	it('stores the full payload on the access key and the identity plus the lineage on the refresh key', async () => {
		await setRedisLoginSessionShopOwner('access-token', 'refresh-token', accessTokenRedisData, true)

		expect(setRedisLoginSession).toHaveBeenCalledExactlyOnceWith('access-token', 'refresh-token', accessTokenRedisData, {
			_id: accessTokenRedisData._id,
			tier: 'shopOwner',
			familyId: expect.stringMatching(UUID),
			originalLogin: `${NOW}`,
			sessionCapDays: '30'
		})
	})

	/*
	 * The session cap, at the writer rather than only at `resolveSessionCapDays`. The three inputs are the three a
	 * caller can actually produce: a ticked box, an unticked one, and an argument that never arrived — and
	 * the last of those takes the **short** cap, so an omission fails towards the shorter session.
	 */
	it.each([
		[true, '30'],
		[false, '1'],
		[undefined, '1']
	])('caps a session whose rememberMe was %o at %s days', async (rememberMe, sessionCapDays) => {
		await setRedisLoginSessionShopOwner('access-token', 'refresh-token', accessTokenRedisData, rememberMe)

		expect(setRedisLoginSession.mock.calls[0][3]).toMatchObject({ sessionCapDays })
	})
})
