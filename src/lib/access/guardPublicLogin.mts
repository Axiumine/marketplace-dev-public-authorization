import { redisClient } from '@axiumine/koa-utils/dataSources/Redis'
import { assertTurnstile } from '@axiumine/marketplace-common/others/assertTurnstile'
import { assertUnderRateLimit } from '@axiumine/marketplace-common/others/assertUnderRateLimit'

/** One hour, in seconds — the window every metered login attempt on this service is counted over. */
export const RATE_WINDOW_SECONDS = 3600

export interface IGuardPublicLoginArgs {
	/** Names the Redis counter. One key is derived from it, `<bucket>:email`. */
	bucket: string
	/**
	 * Already lowercased and trimmed by the caller — otherwise `A@x.it` and `a@x.it` meter separately.
	 *
	 * ⚠️ **Nothing shows you when that is forgotten any more.** The address used to be readable in the
	 * Redis key, so a stray capital was visible to anyone looking at the counters; it is hashed now, and
	 * two spellings simply produce two unrelated digests and two budgets nobody can tell apart.
	 */
	email: string
	turnstileToken?: string
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
 * Why the order is what it is is argued in full at the top of `guardPublicWrite.mts`. In short:
 * verifying a Turnstile token costs an outbound HTTPS round trip and a counter costs one `INCR`, so the
 * cheap check refuses the flood.
 *
 * ⚠️ **The per-address half of the limit lives at the edge and is not missing here.** nginx meters every
 * login endpoint per client address (`conf.d/20-rate-limit.conf`, `mkt_auth` / `mkt_owner_auth` /
 * `mkt_admin_auth`), which is the only layer that can: `app.proxy` is off, so the address Koa reports in
 * this process is nginx's own and the counter this guard used to keep against it was **one global
 * bucket** spent by the whole platform. What is left here is the half no nginx zone can express — a zone keyed on
 * an address never sees the email a distributed source is grinding against.
 *
 * ⚠️ **What differs from the resource service's guard is what the per-email counter costs when it
 * trips.** There, exhausting it means an address cannot *register* for an hour. Here it means an address
 * cannot *sign in* for an hour — anyone who knows a customer's email can lock them out of their own
 * account by failing to log in as them enough times. That is why the limit is set high: high enough that
 * a person mistyping their password all morning never reaches it, low enough that it still caps a
 * distributed guessing attack on one account at a rate bcrypt at `SALT_ROUNDS = 14` makes hopeless.
 */
export async function guardPublicLogin(args: IGuardPublicLoginArgs) {
	const { bucket, email, turnstileToken, perEmailPerHour } = args

	await assertUnderRateLimit(redisClient, `${bucket}:email`, email, perEmailPerHour, RATE_WINDOW_SECONDS)

	await assertTurnstile(turnstileToken)
}
