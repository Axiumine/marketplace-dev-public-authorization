import { OPERATOR_ONLY_FIELDS_SHOP_OWNER } from '@axiumine/marketplace-common/others/operatorOnlyFields'
import type { ClientSession } from 'mongoose'
import { Types } from 'mongoose'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const lean = vi.fn()
const sessionFn = vi.fn(() => ({ lean }))
const findOne = vi.fn(() => ({ session: sessionFn }))
const checkUserAuthorization = vi.fn()

vi.mock('@axiumine/marketplace-common/models/MongoDB/ShopOwner', () => ({ ShopOwner: { findOne } }))
vi.mock('@lib/db/login/checkUserAuthorization.mjs', () => ({ checkUserAuthorization }))

const { tryLoginShopOwner } = await import('../src/lib/db/login/tryLoginShopOwner.mts')

const session = { id: 'session' } as unknown as ClientSession
const user = {
	_id: new Types.ObjectId('507f1f77bcf86cd799439011'),
	login: { password: 'stored-hash', onboardingDone: true, onboardingStep: 'done' }
}

describe('tryLoginShopOwner', () => {
	beforeEach(() => {
		lean.mockReset()
		sessionFn.mockClear()
		findOne.mockClear()
		checkUserAuthorization.mockReset()
	})

	it('returns the lean shopOwner after the password check, inside the caller session', async () => {
		lean.mockResolvedValueOnce(user)

		await expect(tryLoginShopOwner('shop@marketplace.test', 'clear', session)).resolves.toBe(user)

		// The projection is part of the contract: login reads login.lastLogin and the onboarding
		// fields off the result, the password check needs login.password, and the disabled/deleted
		// gate — reached through checkUserAuthorization — needs disabled/deleted.
		expect(findOne).toHaveBeenCalledExactlyOnceWith(
			{ 'login.email': 'shop@marketplace.test' },
			'_id disabled deleted login.password login.firstLogin login.lastLogin login.onboardingStep login.onboardingDone'
		)
		expect(sessionFn).toHaveBeenCalledExactlyOnceWith(session)
		// The whole record goes to the check: it also runs the disabled/deleted gate on it.
		expect(checkUserAuthorization).toHaveBeenCalledExactlyOnceWith(user, 'clear', 'stored-hash')
	})

	// E01-S10, and this is the projection where the temptation is real: login is the obvious place to
	// put "refuse a shop owner who is still waiting for approval", and it deliberately does not — the
	// gate lives downstream, and pulling `waitApprov` in here would be step one of moving it. The
	// literal above fails on any change at all, but its fix is to paste the new string in; this line
	// names what may never appear in it, from the list owned by the repo that owns the shape.
	// `stringContaining` rather than a token split: `shopOwnerNotes` is the same leak renamed.
	it('projects no field the Admin tier owns', async () => {
		lean.mockResolvedValueOnce(user)

		await tryLoginShopOwner('shop@marketplace.test', 'clear', session)

		for (const field of OPERATOR_ONLY_FIELDS_SHOP_OWNER)
			expect(findOne).toHaveBeenCalledExactlyOnceWith(
				{ 'login.email': 'shop@marketplace.test' },
				expect.not.stringContaining(field)
			)
	})

	it('rejects with Unauthorized when the email matches no shopOwner', async () => {
		lean.mockResolvedValueOnce(null)

		await expect(tryLoginShopOwner('nobody@marketplace.test', 'clear', session)).rejects.toThrow('Unauthorized')
		expect(checkUserAuthorization).not.toHaveBeenCalled()
	})

	it('propagates the rejection from the password / disabled-deleted check', async () => {
		lean.mockResolvedValueOnce(user)
		checkUserAuthorization.mockRejectedValueOnce(new Error('Unauthorized'))

		await expect(tryLoginShopOwner('shop@marketplace.test', 'wrong', session)).rejects.toThrow('Unauthorized')
	})
})
