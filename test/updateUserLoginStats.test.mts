import type { ClientSession } from 'mongoose'
import { Types } from 'mongoose'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const updateOne = vi.fn()

vi.mock('@axiumine/marketplace-common/models/MongoDB/User', () => ({ User: { updateOne } }))

const { updateUserLoginStats } = await import('../src/lib/db/login/updateUserLoginStats.mts')

const _id = new Types.ObjectId('507f1f77bcf86cd799439011')
const session = { id: 'session' } as unknown as ClientSession

// The function is three lines of delegation to `funUpdateLoginStats`, and the only thing it decides is
// which collection the update lands on. Mocking the model rather than the delegate is what makes that
// visible: a copy-paste that left `ShopOwner` in here would pass every assertion about the update
// document and still stamp the wrong tier's row.
describe('updateUserLoginStats', () => {
	beforeEach(() => updateOne.mockReset())

	it('stamps firstLogin too, and sets rememberMe, on the very first login', async () => {
		await updateUserLoginStats(_id, null, true, session)

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

	it('only refreshes lastLogin and unsets rememberMe afterwards', async () => {
		await updateUserLoginStats(_id, new Date('2026-01-01T00:00:00.000Z'), false, session)

		expect(updateOne).toHaveBeenCalledExactlyOnceWith(
			{ _id },
			{ $set: { 'login.lastLogin': expect.any(Date) }, $unset: { 'login.rememberMe': 1 } },
			{ session, runValidators: true }
		)
	})
})
