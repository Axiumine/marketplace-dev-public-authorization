import { beforeEach, describe, expect, it, vi } from 'vitest'

const compareHashAsync = vi.fn()

vi.mock('@axiumine/koa-utils/lib/hash', () => ({ compareHashAsync }))

const { compareAgainstDummyHash } = await import('../src/lib/db/login/compareAgainstDummyHash.mts')

describe('compareAgainstDummyHash', () => {
	beforeEach(() => {
		compareHashAsync.mockReset()
	})

	// B44: the whole point is a real bcrypt-cost compare, not a shortcut — asserted against the fixed
	// hash constant so a future edit that swapped it for something cheaper (or dropped the call
	// entirely) would fail here, and the caller-supplied password is what reaches it, never a
	// hardcoded stand-in that would make the compare always run the same branch inside bcrypt.
	it('compares the caller-supplied password against the fixed dummy hash', async () => {
		compareHashAsync.mockResolvedValueOnce(false)

		await expect(compareAgainstDummyHash('whatever the caller typed')).resolves.toBeUndefined()

		expect(compareHashAsync).toHaveBeenCalledExactlyOnceWith(
			'whatever the caller typed',
			'$2b$14$a/hyKqhGryzvbkfvT/5h3.UUO9aGXEmh3VlVVods6LdQXe6PJk/4q'
		)
	})

	// The result is discarded on purpose — this is a timing decoy, never a real check — but the
	// underlying compare still has to run to completion (and to propagate a genuine failure) rather
	// than being fired and ignored.
	it('propagates a rejection from the underlying compare rather than swallowing it', async () => {
		compareHashAsync.mockRejectedValueOnce(new Error('bcrypt blew up'))

		await expect(compareAgainstDummyHash('clear')).rejects.toThrow('bcrypt blew up')
	})
})
