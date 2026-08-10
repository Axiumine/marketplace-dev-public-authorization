import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const setRedisLoginSession = vi.fn()

vi.mock('@lib/db/redis/setRedisLoginSession.mjs', () => ({ setRedisLoginSession }))

const { setRedisLoginSessionAdmin } = await import('../src/lib/db/redis/setRedisLoginSessionAdmin.mts')

const NOW = 1_754_784_000_000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('setRedisLoginSessionAdmin', () => {
	const accessTokenRedisData = {
		_id: '507f1f77bcf86cd799439011',
		email: 'operator@marketplace.test',
		tier: 'admin' as const
	}

	beforeEach(() => {
		setRedisLoginSession.mockReset()
		vi.useFakeTimers({ toFake: ['Date'] })
		vi.setSystemTime(NOW)
	})

	afterEach(() => vi.useRealTimers())

	/*
	 * Same split as the shopOwner tier — only the identity, the tier and the lineage survive on the refresh
	 * key — but the admin payload has no onboarding data to carry.
	 *
	 * ⚠️ **Both hashes are asserted whole, not by subset** (E14-S01). The access hash is read by every
	 * resource service on every request and its shape has to stay identical to the one `refreshSessionTokens`
	 * writes on a rotation; the refresh hash has to carry all three lineage fields, because
	 * `assertRefreshLineage` refuses a session missing any of them and a writer that dropped one would mint
	 * sessions that die on their first refresh.
	 */
	it('stores the full payload on the access key and the identity plus the lineage on the refresh key', async () => {
		await setRedisLoginSessionAdmin('access-token', 'refresh-token', accessTokenRedisData, true)

		expect(setRedisLoginSession).toHaveBeenCalledExactlyOnceWith('access-token', 'refresh-token', accessTokenRedisData, {
			_id: accessTokenRedisData._id,
			tier: 'admin',
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
		await setRedisLoginSessionAdmin('access-token', 'refresh-token', accessTokenRedisData, rememberMe)

		expect(setRedisLoginSession.mock.calls[0][3]).toMatchObject({ sessionCapDays })
	})
})
