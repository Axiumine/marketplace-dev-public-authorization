import type { ClientSession } from 'mongoose'
import { Types } from 'mongoose'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const lean = vi.fn()
const sessionFn = vi.fn(() => ({ lean }))
const findOne = vi.fn(() => ({ session: sessionFn }))
const checkUserAuthorization = vi.fn()

vi.mock('@thedoctorweb_agency/marketplace-common/models/MongoDB/User', () => ({ User: { findOne } }))
vi.mock('@lib/db/login/checkUserAuthorization.mjs', () => ({ checkUserAuthorization }))

const { tryLoginUser } = await import('../src/lib/db/login/tryLoginUser.mts')

const session = { id: 'session' } as unknown as ClientSession
const user = {
	_id: new Types.ObjectId('507f1f77bcf86cd799439011'),
	login: { password: 'stored-hash' },
	emailVerify: { valid: true }
}

describe('tryLoginUser', () => {
	beforeEach(() => {
		lean.mockReset()
		sessionFn.mockClear()
		findOne.mockClear()
		checkUserAuthorization.mockReset()
	})

	it('returns the lean customer after the password check, inside the caller session', async () => {
		lean.mockResolvedValueOnce(user)

		await expect(tryLoginUser('customer@marketplace.test', 'clear', session)).resolves.toBe(user)

		// The projection is the contract, and it differs from the ShopOwner one in exactly two places:
		// no onboarding fields, because a customer is walked through nothing, and emailVerify.valid,
		// which is the gate below.
		expect(findOne).toHaveBeenCalledExactlyOnceWith(
			{ 'login.email': 'customer@marketplace.test' },
			'_id disabled deleted emailVerify.valid login.password login.firstLogin login.lastLogin'
		)
		expect(sessionFn).toHaveBeenCalledExactlyOnceWith(session)
		expect(checkUserAuthorization).toHaveBeenCalledExactlyOnceWith(user, 'clear', 'stored-hash')
	})

	it('rejects with Unauthorized when the email matches no customer', async () => {
		lean.mockResolvedValueOnce(null)

		await expect(tryLoginUser('nobody@marketplace.test', 'clear', session)).rejects.toThrow('Unauthorized')
		expect(checkUserAuthorization).not.toHaveBeenCalled()
	})

	it('propagates the rejection from the password / disabled-deleted check', async () => {
		lean.mockResolvedValueOnce(user)
		checkUserAuthorization.mockRejectedValueOnce(new Error('Unauthorized'))

		await expect(tryLoginUser('customer@marketplace.test', 'wrong', session)).rejects.toThrow('Unauthorized')
	})

	/*
	 * The gate that has no counterpart on the other two tiers, and the three shapes it has to read the
	 * same way.
	 *
	 * ⚠️ It runs AFTER the password check on purpose — see the comment on the function. Asserting that
	 * ordering is the point of `expect(checkUserAuthorization).toHaveBeenCalled()` below: a refactor
	 * that moved the gate up would still reject, and would still pass a test that only checked the
	 * message, while handing an attacker who supplied no password the news that the address exists.
	 */
	it.each([
		['emailVerify missing entirely', { ...user, emailVerify: undefined }],
		['emailVerify present with no valid flag', { ...user, emailVerify: {} }],
		['emailVerify.valid explicitly false', { ...user, emailVerify: { valid: false } }]
	])('rejects an unconfirmed customer with the same generic error — %s', async (_label, unconfirmed) => {
		lean.mockResolvedValueOnce(unconfirmed)

		await expect(tryLoginUser('customer@marketplace.test', 'clear', session)).rejects.toThrow('Unauthorized')
		expect(checkUserAuthorization).toHaveBeenCalledExactlyOnceWith(unconfirmed, 'clear', 'stored-hash')
	})
})
