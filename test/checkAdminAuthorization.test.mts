import type { IAuthorizationDisDel } from '@axiumine/koa-utils/lib/IAuthorizationDisDel'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const compareHashAsync = vi.fn()
const checkUserAuthorizationDisDel = vi.fn()

vi.mock('@axiumine/koa-utils/lib/hash', () => ({ compareHashAsync }))
vi.mock('@thedoctorweb_agency/marketplace-common/others/checkUserAuthorizationDisDel', () => ({ checkUserAuthorizationDisDel }))

const { checkAdminAuthorization } = await import('../src/lib/db/login/checkAdminAuthorization.mts')

const admin = { disabled: false } as IAuthorizationDisDel

describe('checkAdminAuthorization', () => {
	beforeEach(() => {
		compareHashAsync.mockReset()
		checkUserAuthorizationDisDel.mockReset()
	})

	it('runs the disabled/deleted gate once the password matches', async () => {
		compareHashAsync.mockResolvedValueOnce(true)

		await expect(checkAdminAuthorization(admin, 'clear', 'hash')).resolves.toBeUndefined()
		expect(compareHashAsync).toHaveBeenCalledExactlyOnceWith('clear', 'hash')
		expect(checkUserAuthorizationDisDel).toHaveBeenCalledExactlyOnceWith(admin)
	})

	// Same rejection as an unknown email: the caller must not be able to tell the two apart.
	// Order matters too — a wrong password must not reveal whether the account exists or is disabled.
	it('rejects with Unauthorized without reaching the gate when the password does not match', async () => {
		compareHashAsync.mockResolvedValueOnce(false)

		await expect(checkAdminAuthorization(admin, 'clear', 'hash')).rejects.toThrow('Unauthorized')
		expect(checkUserAuthorizationDisDel).not.toHaveBeenCalled()
	})

	it('propagates the gate rejection for a disabled or deleted admin', async () => {
		compareHashAsync.mockResolvedValueOnce(true)
		checkUserAuthorizationDisDel.mockImplementationOnce(() => {
			throw new Error('disabled')
		})

		await expect(checkAdminAuthorization(admin, 'clear', 'hash')).rejects.toThrow('disabled')
	})
})
