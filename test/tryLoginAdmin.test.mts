import type { ClientSession } from 'mongoose'
import { Types } from 'mongoose'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const lean = vi.fn()
const sessionFn = vi.fn(() => ({ lean }))
const findOne = vi.fn(() => ({ session: sessionFn }))
const checkAdminAuthorization = vi.fn()

vi.mock('@thedoctorweb_agency/marketplace-common/models/MongoDB/Admin', () => ({ Admin: { findOne } }))
vi.mock('@lib/db/login/checkAdminAuthorization.mjs', () => ({ checkAdminAuthorization }))

const { tryLoginAdmin } = await import('../src/lib/db/login/tryLoginAdmin.mts')

const session = { id: 'session' } as unknown as ClientSession
const admin = {
	_id: new Types.ObjectId('507f1f77bcf86cd799439011'),
	login: { password: 'stored-hash', lastLogin: new Date('2026-01-01T00:00:00.000Z') }
}

describe('tryLoginAdmin', () => {
	beforeEach(() => {
		lean.mockReset()
		sessionFn.mockClear()
		findOne.mockClear()
		checkAdminAuthorization.mockReset()
	})

	it('returns the lean admin after the password check, inside the caller session', async () => {
		lean.mockResolvedValueOnce(admin)

		await expect(tryLoginAdmin('operator@marketplace.test', 'clear', session)).resolves.toBe(admin)

		// The projection is part of the contract: loginAdmin reads _id and login.lastLogin off the
		// result, and the password check needs login.password.
		expect(findOne).toHaveBeenCalledExactlyOnceWith(
			{ 'login.email': 'operator@marketplace.test' },
			'_id disabled deleted login.password login.lastLogin'
		)
		expect(sessionFn).toHaveBeenCalledExactlyOnceWith(session)
		// The whole lean admin goes in, not just the hash: the disabled/deleted gate inside reads
		// the projected flags off it.
		expect(checkAdminAuthorization).toHaveBeenCalledExactlyOnceWith(admin, 'clear', 'stored-hash')
	})

	it('rejects with Unauthorized when the email matches no admin', async () => {
		lean.mockResolvedValueOnce(null)

		await expect(tryLoginAdmin('nobody@marketplace.test', 'clear', session)).rejects.toThrow('Unauthorized')
		expect(checkAdminAuthorization).not.toHaveBeenCalled()
	})

	it('propagates the rejection from the password check', async () => {
		lean.mockResolvedValueOnce(admin)
		checkAdminAuthorization.mockRejectedValueOnce(new Error('Unauthorized'))

		await expect(tryLoginAdmin('operator@marketplace.test', 'wrong', session)).rejects.toThrow('Unauthorized')
	})
})
