import { redisClient } from '@axiumine/koa-utils/dataSources/Redis'
import { assertTurnstile } from '@thedoctorweb_agency/marketplace-common/others/assertTurnstile'
import { assertUnderRateLimit } from '@thedoctorweb_agency/marketplace-common/others/assertUnderRateLimit'
import { Context } from 'koa'

/** One hour, in seconds — the window every metered login attempt on this service is counted over. */
export const RATE_WINDOW_SECONDS = 3600

export interface IGuardPublicLoginArgs {
	/** Names the Redis counters. Two keys are derived from it, `<bucket>:ip` and `<bucket>:email`. */
	bucket: string
	/** Already lowercased and trimmed by the caller — otherwise `A@x.it` and `a@x.it` meter separately. */
	email: string
	turnstileToken?: string
	perIpPerHour: number
	perEmailPerHour: number
}

/**
 * The gate in front of a login resolver: rate limit first, captcha second.
 *
 * ⚠️ **This is a deliberate near-duplicate of `guardPublicWrite.mts` in
 * `marketplace-dev-public-resource`, not an oversight — a fix to one belongs in both.** It is not shared
 * through `marketplace-common` because the two pieces it composes already are, and the composition needs
 * the one thing common refuses to take on: `redisClient`. `assertUnderRateLimit` takes its store as a
 * *parameter* precisely so the library never imports `redis`, which is a dependency of the services and
 * not of a package whose other consumers only want Mongoose models. Promoting eleven lines of wiring
 * would put a Redis install behind every one of them.
 *
 * Why the order is what it is, and why there are two counters, is argued in full at the top of
 * `guardPublicWrite.mts`. In short: verifying a Turnstile token costs an outbound HTTPS round trip and a
 * counter costs one `INCR`, so the cheap check refuses the flood; and a per-IP limit bounds one source
 * enumerating many addresses while a per-email limit bounds many sources hammering one account.
 *
 * ⚠️ **What differs from the resource service's guard is what the per-email counter costs when it
 * trips.** There, exhausting it means an address cannot *register* for an hour. Here it means an address
 * cannot *sign in* for an hour — anyone who knows a customer's email can lock them out of their own
 * account by failing to log in as them enough times. That is why the per-email limit here is set far
 * higher than the per-IP one: high enough that a person mistyping their password all morning never
 * reaches it, low enough that it still caps a distributed guessing attack on one account at a rate
 * bcrypt at `SALT_ROUNDS = 14` makes hopeless. The per-IP counter is the one doing the real work.
 */
export async function guardPublicLogin(ctx: Context, args: IGuardPublicLoginArgs) {
	const { bucket, email, turnstileToken, perIpPerHour, perEmailPerHour } = args

	await assertUnderRateLimit(redisClient, `${bucket}:ip`, ctx.ip, perIpPerHour, RATE_WINDOW_SECONDS)
	await assertUnderRateLimit(redisClient, `${bucket}:email`, email, perEmailPerHour, RATE_WINDOW_SECONDS)

	await assertTurnstile(turnstileToken, ctx.ip)
}
