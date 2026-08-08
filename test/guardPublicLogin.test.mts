import type { Context } from 'koa'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const assertUnderRateLimit = vi.fn()
const assertTurnstile = vi.fn()
const redisClient = { id: 'redis-client' }

vi.mock('@axiumine/koa-utils/dataSources/Redis', () => ({ redisClient }))
vi.mock('@axiumine/marketplace-common/others/assertUnderRateLimit', () => ({ assertUnderRateLimit }))
vi.mock('@axiumine/marketplace-common/others/assertTurnstile', () => ({ assertTurnstile }))

const { guardPublicLogin, RATE_WINDOW_SECONDS } = await import('../src/lib/access/guardPublicLogin.mts')

const ctx = { ip: '203.0.113.7' } as Context

const args = {
	bucket: 'loginUser',
	email: 'customer@marketplace.test',
	turnstileToken: 'turnstile-token',
	perIpPerHour: 20,
	perEmailPerHour: 60
}

describe('guardPublicLogin', () => {
	beforeEach(() => {
		assertUnderRateLimit.mockReset()
		assertTurnstile.mockReset()
	})

	it('meters the IP and the email on two separate keys, then verifies the captcha', async () => {
		await expect(guardPublicLogin(ctx, args)).resolves.toBeUndefined()

		expect(assertUnderRateLimit).toHaveBeenCalledTimes(2)
		// Two distinct keys off one bucket: the counters must not share a namespace, or an address and
		// an IP would spend the same budget and the lower of the two limits would win for both.
		expect(assertUnderRateLimit).toHaveBeenNthCalledWith(1, redisClient, 'loginUser:ip', ctx.ip, 20, RATE_WINDOW_SECONDS)
		expect(assertUnderRateLimit).toHaveBeenNthCalledWith(2, redisClient, 'loginUser:email', args.email, 60, RATE_WINDOW_SECONDS)
		expect(assertTurnstile).toHaveBeenCalledExactlyOnceWith(args.turnstileToken, ctx.ip)
	})

	it('counts over an hour', () => expect(RATE_WINDOW_SECONDS).toBe(3600))

	// The cheap check refuses the flood: a caller over the IP limit must cost this process one INCR,
	// never a Turnstile round trip — and never the second counter either, which is what would let a
	// flood from one machine burn a stranger's per-email budget on the way to being refused.
	it('stops at the IP counter without touching the email counter or the captcha', async () => {
		assertUnderRateLimit.mockRejectedValueOnce(new Error('Too Many Requests'))

		await expect(guardPublicLogin(ctx, args)).rejects.toThrow('Too Many Requests')

		expect(assertUnderRateLimit).toHaveBeenCalledTimes(1)
		expect(assertTurnstile).not.toHaveBeenCalled()
	})

	it('stops at the email counter without verifying the captcha', async () => {
		assertUnderRateLimit.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('Too Many Requests'))

		await expect(guardPublicLogin(ctx, args)).rejects.toThrow('Too Many Requests')

		expect(assertUnderRateLimit).toHaveBeenCalledTimes(2)
		expect(assertTurnstile).not.toHaveBeenCalled()
	})

	it('propagates a failed captcha verification', async () => {
		assertTurnstile.mockRejectedValueOnce(new Error('Forbidden'))

		await expect(guardPublicLogin(ctx, args)).rejects.toThrow('Forbidden')
	})

	// ⚠️ A missing token is passed through as undefined rather than short-circuited here. The gate is
	// `assertTurnstile`'s to make: it verifies only when this process holds a secret key, so a machine
	// with no key accepts the tokenless request a browser with no site key sends, and a deployment that
	// has one rejects it. Deciding it in the guard would let the client weaken the gate by omitting the
	// field.
	it('hands a missing token to assertTurnstile instead of skipping it', async () => {
		await guardPublicLogin(ctx, { ...args, turnstileToken: undefined })

		expect(assertTurnstile).toHaveBeenCalledExactlyOnceWith(undefined, ctx.ip)
	})
})
