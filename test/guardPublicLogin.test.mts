import { beforeEach, describe, expect, it, vi } from 'vitest'

const assertUnderRateLimit = vi.fn()
const assertTurnstile = vi.fn()
const redisClient = { id: 'redis-client' }

vi.mock('@axiumine/koa-utils/dataSources/Redis', () => ({ redisClient }))
vi.mock('@axiumine/marketplace-common/others/assertUnderRateLimit', () => ({ assertUnderRateLimit }))
vi.mock('@axiumine/marketplace-common/others/assertTurnstile', () => ({ assertTurnstile }))

const { guardPublicLogin, RATE_WINDOW_SECONDS } = await import('../src/lib/access/guardPublicLogin.mts')

const args = {
	bucket: 'loginUser',
	email: 'customer@marketplace.test',
	turnstileToken: 'turnstile-token',
	perEmailPerHour: 60
}

describe('guardPublicLogin', () => {
	beforeEach(() => {
		assertUnderRateLimit.mockReset()
		assertTurnstile.mockReset()
	})

	// ⚠️ **One counter, and it is the address one.** The per-caller half is nginx's (`mkt_auth` /
	// `mkt_owner_auth` / `mkt_admin_auth`) because `app.proxy` is off, so the only address this process
	// can see is the proxy's own — a counter kept against it was one global bucket for the whole platform.
	it('meters the email on one key, then verifies the captcha', async () => {
		await expect(guardPublicLogin(args)).resolves.toBeUndefined()

		expect(assertUnderRateLimit).toHaveBeenCalledExactlyOnceWith(
			redisClient,
			'loginUser:email',
			args.email,
			60,
			RATE_WINDOW_SECONDS
		)
		expect(assertTurnstile).toHaveBeenCalledExactlyOnceWith(args.turnstileToken)
	})

	// The identity goes to `assertUnderRateLimit` as typed, not hashed here: the hashing is that
	// function's, and doing it twice would key the counter on the digest of a digest.
	it('hands the address to the limiter unhashed and lets it do the hashing', async () => {
		await guardPublicLogin(args)

		expect(assertUnderRateLimit.mock.calls[0][2]).toBe('customer@marketplace.test')
	})

	// The bucket name is the caller's, so the three login mutations never share a counter: a shop owner
	// mistyping their password must not spend a customer's budget.
	it('names the counter after the caller’s bucket', async () => {
		await guardPublicLogin({ ...args, bucket: 'loginAdmin' })

		expect(assertUnderRateLimit.mock.calls[0][1]).toBe('loginAdmin:email')
	})

	it('counts over an hour', () => expect(RATE_WINDOW_SECONDS).toBe(3600))

	// The cheap check refuses the flood: a caller over the limit must cost this process one INCR, never
	// a Turnstile round trip.
	it('stops at the email counter without verifying the captcha', async () => {
		assertUnderRateLimit.mockRejectedValueOnce(new Error('Too Many Requests'))

		await expect(guardPublicLogin(args)).rejects.toThrow('Too Many Requests')

		expect(assertUnderRateLimit).toHaveBeenCalledTimes(1)
		expect(assertTurnstile).not.toHaveBeenCalled()
	})

	it('propagates a failed captcha verification', async () => {
		assertTurnstile.mockRejectedValueOnce(new Error('Forbidden'))

		await expect(guardPublicLogin(args)).rejects.toThrow('Forbidden')
	})

	// ⚠️ A missing token is passed through as undefined rather than short-circuited here. The gate is
	// `assertTurnstile`'s to make: it verifies only when this process holds a secret key, so a machine
	// with no key accepts the tokenless request a browser with no site key sends, and a deployment that
	// has one rejects it. Deciding it in the guard would let the client weaken the gate by omitting the
	// field.
	it('hands a missing token to assertTurnstile instead of skipping it', async () => {
		await guardPublicLogin({ ...args, turnstileToken: undefined })

		expect(assertTurnstile).toHaveBeenCalledExactlyOnceWith(undefined)
	})

	// ⚠️ **Nothing but the token reaches Cloudflare.** `assertTurnstile` used to take the caller's
	// address as a second argument and forward it as `remoteip`; with `app.proxy` off that value was
	// nginx's own, so every siteverify call reported the same machine. The parameter is gone, and this
	// pins that the guard does not resurrect it from somewhere else.
	it('sends the captcha nothing beyond the token', async () => {
		await guardPublicLogin(args)

		expect(assertTurnstile.mock.calls[0]).toHaveLength(1)
	})
})
