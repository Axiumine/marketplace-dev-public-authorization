import {
	APPROVAL_GATE_FIELD_SHOP_OWNER,
	OPERATOR_ONLY_FIELDS_SHOP_OWNER
} from '@axiumine/marketplace-common/others/operatorOnlyFields'
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
		// fields off the result, the password check needs login.password, the disabled/deleted
		// gate — reached through checkUserAuthorization — needs disabled/deleted, and the approval
		// gate needs waitApprov.
		expect(findOne).toHaveBeenCalledExactlyOnceWith(
			{ 'login.email': 'shop@marketplace.test' },
			'_id disabled deleted waitApprov login.password login.firstLogin login.lastLogin login.onboardingStep login.onboardingDone'
		)
		expect(sessionFn).toHaveBeenCalledExactlyOnceWith(session)
		// The whole record goes to the check: it also runs the disabled/deleted gate on it.
		expect(checkUserAuthorization).toHaveBeenCalledExactlyOnceWith(user, 'clear', 'stored-hash')
	})

	// E01-S10. The literal above fails on any change at all, but its fix is to paste the new string in;
	// this line names what may never appear in it, from the list owned by the repo that owns the shape.
	// `stringContaining` rather than a token split: `shopOwnerNotes` is the same leak renamed.
	//
	// `waitApprov` was on that list until the approval-gate fix and is not any more — it is read here
	// now, one line below. What was never in question is the write: BC-03 raises and clears the flag,
	// and the eslint block in this repo refuses a `Property` naming it anywhere under src/**.
	it('projects no field the Admin tier owns', async () => {
		lean.mockResolvedValueOnce(user)

		await tryLoginShopOwner('shop@marketplace.test', 'clear', session)

		for (const field of OPERATOR_ONLY_FIELDS_SHOP_OWNER)
			expect(findOne).toHaveBeenCalledExactlyOnceWith(
				{ 'login.email': 'shop@marketplace.test' },
				expect.not.stringContaining(field)
			)
	})

	// The mirror of the assertion above, and the one that actually keeps the gate alive:
	// `checkShopOwnerApproval` cannot refuse a flag it was never handed, so a projection quietly
	// dropping `waitApprov` would leave the call below it in place, looking correct, and letting every
	// parked shop owner log in. Named off the same constant, so a rename of the field fails here too.
	it('projects the approval gate field, or the gate below it can never fire', async () => {
		lean.mockResolvedValueOnce(user)

		await tryLoginShopOwner('shop@marketplace.test', 'clear', session)

		expect(findOne).toHaveBeenCalledExactlyOnceWith(
			{ 'login.email': 'shop@marketplace.test' },
			expect.stringContaining(APPROVAL_GATE_FIELD_SHOP_OWNER)
		)
	})

	// The point of the whole change: an operator raising `waitApprov` parks the account, and until this
	// gate existed that did nothing — the shop owner logged in and worked as usual.
	it('rejects with Unauthorized a shopOwner still awaiting approval', async () => {
		lean.mockResolvedValueOnce({ ...user, waitApprov: true })

		await expect(tryLoginShopOwner('shop@marketplace.test', 'clear', session)).rejects.toThrow('Unauthorized')
	})

	// ⚠️ Order, and it is a security property rather than a style choice: the gate runs *after* the
	// password check, exactly as the disabled/deleted one does. Moving it above `checkUserAuthorization`
	// would answer "is this account parked?" to anyone who knows the email and no password at all —
	// a state oracle on accounts the caller has not authenticated as. Same reasoning as tryLoginUser.
	it('runs the password check before refusing a parked shopOwner', async () => {
		lean.mockResolvedValueOnce({ ...user, waitApprov: true })

		await expect(tryLoginShopOwner('shop@marketplace.test', 'clear', session)).rejects.toThrow('Unauthorized')
		expect(checkUserAuthorization).toHaveBeenCalledExactlyOnceWith({ ...user, waitApprov: true }, 'clear', 'stored-hash')
	})

	// `waitApprov` is truthy-or-absent in the collection — `funShopOwnerUpdateStatus` `$unset`s it on
	// approval so the operator queue can stay a `{ $exists: true }` query — but an explicit `false` is
	// a shape a document could carry, and refusing it would lock out every approved shop owner.
	it('lets a shopOwner through when waitApprov is explicitly false', async () => {
		const approved = { ...user, waitApprov: false }
		lean.mockResolvedValueOnce(approved)

		await expect(tryLoginShopOwner('shop@marketplace.test', 'clear', session)).resolves.toBe(approved)
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
