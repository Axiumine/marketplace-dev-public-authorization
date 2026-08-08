import type { IAuthorizationDisDel } from '@axiumine/koa-utils/lib/IAuthorizationDisDel'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const compareHashAsync = vi.fn()
const checkUserAuthorizationDisDel = vi.fn()

vi.mock('@axiumine/koa-utils/lib/hash', () => ({ compareHashAsync }))
vi.mock('@axiumine/marketplace-common/others/checkUserAuthorizationDisDel', () => ({ checkUserAuthorizationDisDel }))

const { checkUserAuthorization } = await import('../src/lib/db/login/checkUserAuthorization.mts')

const user = { disabled: false } as IAuthorizationDisDel

describe('checkUserAuthorization', () => {
	beforeEach(() => {
		compareHashAsync.mockReset()
		checkUserAuthorizationDisDel.mockReset()
	})

	it('runs the disabled/deleted gate once the password matches', async () => {
		compareHashAsync.mockResolvedValueOnce(true)

		await expect(checkUserAuthorization(user, 'clear', 'hash')).resolves.toBeUndefined()
		expect(compareHashAsync).toHaveBeenCalledExactlyOnceWith('clear', 'hash')
		expect(checkUserAuthorizationDisDel).toHaveBeenCalledExactlyOnceWith(user)
	})

	// Order matters: a wrong password must not reveal whether the account exists or is disabled.
	it('rejects with Unauthorized without reaching the gate when the password is wrong', async () => {
		compareHashAsync.mockResolvedValueOnce(false)

		await expect(checkUserAuthorization(user, 'clear', 'hash')).rejects.toThrow('Unauthorized')
		expect(checkUserAuthorizationDisDel).not.toHaveBeenCalled()
	})

	it('propagates the gate rejection for a disabled or deleted shopOwner', async () => {
		compareHashAsync.mockResolvedValueOnce(true)
		checkUserAuthorizationDisDel.mockImplementationOnce(() => {
			throw new Error('disabled')
		})

		await expect(checkUserAuthorization(user, 'clear', 'hash')).rejects.toThrow('disabled')
	})
})
