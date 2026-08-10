import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const setRedisLoginSession = vi.fn()

vi.mock('@lib/db/redis/setRedisLoginSession.mjs', () => ({ setRedisLoginSession }))

const { setRedisLoginSessionUser } = await import('../src/lib/db/redis/setRedisLoginSessionUser.mts')

const NOW = 1_754_784_000_000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('setRedisLoginSessionUser', () => {
	const accessTokenRedisData = {
		_id: '507f1f77bcf86cd799439011',
		email: 'customer@marketplace.test',
		tier: 'user' as const
	}

	beforeEach(() => {
		setRedisLoginSession.mockReset()
		vi.useFakeTimers({ toFake: ['Date'] })
		vi.setSystemTime(NOW)
	})

	afterEach(() => vi.useRealTimers())

	/*
	 * The customer tier splits the two hashes exactly as the other two do — the identity, the tier and the
	 * lineage on the refresh key, everything the SPA reads on the access key.
	 *
	 * Both hashes are asserted whole rather than by subset (E14-S01): a writer that dropped one lineage
	 * field would mint sessions `assertRefreshLineage` refuses on their first rotation.
	 */
	it('stores the full payload on the access key and the identity plus the lineage on the refresh key', async () => {
		await setRedisLoginSessionUser('access-token', 'refresh-token', accessTokenRedisData, true)

		expect(setRedisLoginSession).toHaveBeenCalledExactlyOnceWith('access-token', 'refresh-token', accessTokenRedisData, {
			_id: accessTokenRedisData._id,
			tier: 'user',
			familyId: expect.stringMatching(UUID),
			originalLogin: `${NOW}`,
			sessionCapDays: '30'
		})
	})

	/*
	 * E14-S07, at the writer rather than only at `resolveSessionCapDays`. The three inputs are the three a
	 * caller can actually produce: a ticked box, an unticked one, and an argument that never arrived — and
	 * the last of those takes the **short** cap, so an omission fails towards the shorter session.
	 */
	it.each([
		[true, '30'],
		[false, '1'],
		[undefined, '1']
	])('caps a session whose rememberMe was %o at %s days', async (rememberMe, sessionCapDays) => {
		await setRedisLoginSessionUser('access-token', 'refresh-token', accessTokenRedisData, rememberMe)

		expect(setRedisLoginSession.mock.calls[0][3]).toMatchObject({ sessionCapDays })
	})
})
