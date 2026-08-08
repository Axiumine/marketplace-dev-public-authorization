import type { ClientSession } from 'mongoose'
import { Types } from 'mongoose'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const updateOne = vi.fn()

vi.mock('@axiumine/marketplace-common/models/MongoDB/ShopOwner', () => ({ ShopOwner: { updateOne } }))

const { updateLoginStats } = await import('../src/lib/db/login/updateLoginStats.mts')

const _id = new Types.ObjectId('507f1f77bcf86cd799439011')
const session = { id: 'session' } as unknown as ClientSession

describe('updateLoginStats', () => {
	beforeEach(() => updateOne.mockReset())

	it('stamps firstLogin too, and sets rememberMe, on the very first login', async () => {
		await updateLoginStats(_id, null, true, session)

		expect(updateOne).toHaveBeenCalledExactlyOnceWith(
			{ _id },
			{
				$set: {
					'login.lastLogin': expect.any(Date),
					'login.firstLogin': expect.any(Date),
					'login.rememberMe': true
				},
				$unset: {}
			},
			{ session, runValidators: true }
		)
	})

	// Not the first login and rememberMe off: firstLogin is left alone and the flag is removed
	// rather than set to false, so the field simply stops existing.
	it('only refreshes lastLogin and unsets rememberMe afterwards', async () => {
		await updateLoginStats(_id, new Date('2026-01-01T00:00:00.000Z'), false, session)

		expect(updateOne).toHaveBeenCalledExactlyOnceWith(
			{ _id },
			{ $set: { 'login.lastLogin': expect.any(Date) }, $unset: { 'login.rememberMe': 1 } },
			{ session, runValidators: true }
		)
	})
})
