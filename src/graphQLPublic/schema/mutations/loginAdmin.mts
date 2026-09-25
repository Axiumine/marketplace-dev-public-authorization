import { IContextLogin } from '@axiumine/koa-utils/graphQL/schema/context/IContextLogin'
import { LoginAppType } from '@axiumine/koa-utils/graphQL/schema/types/LoginAppType'
import { setLoginCookies } from '@axiumine/koa-utils/lib/setLoginCookies'
import { generateAccessToken, generateRefreshToken } from '@axiumine/koa-utils/lib/tokens'
import { tryCatchRethrow } from '@axiumine/koa-utils/lib/tryCatchRethrow'
import { IRedisDataAdmin } from '@axiumine/marketplace-common/others/Redis/IRedisDataAdmin'
import { TIER } from '@axiumine/marketplace-common/others/Tier'
import { guardPublicLogin } from '@lib/access/guardPublicLogin.mjs'
import { tryLoginAdmin } from '@lib/db/login/tryLoginAdmin.mjs'
import { updateAdminLoginStats } from '@lib/db/login/updateAdminLoginStats.mjs'
import { setRedisLoginSessionAdmin } from '@lib/db/redis/setRedisLoginSessionAdmin.mjs'
import { GraphQLBoolean, GraphQLError, GraphQLNonNull, GraphQLString } from 'graphql'
import mongoose from 'mongoose'

interface IArgs {
	email: string
	password: string
	rememberMe: boolean
	turnstileToken?: string
}

/**
 * Per hour, per email address — the only counter this process keeps, the per-address half being
 * nginx's (`mkt_admin_auth`), which is tighter here than on the other two vhosts.
 *
 * ⚠️ Anyone who knows an admin's address can spend this budget on their behalf, so the number is a
 * lockout risk before it is a defence, and locking out the people who administer the platform is worse than
 * locking out one customer: they are also the ones who would respond to the attack. At 30 it stays out of
 * the way of somebody mistyping a password all morning, while still capping a *distributed* attack on one
 * account — and at `SALT_ROUNDS = 14`, 30 bcrypt verifications an hour is not a search anyone finishes.
 */
const PER_EMAIL_PER_HOUR = 30

/**
 * Logs a platform admin in.
 *
 * ⚠️ **`turnstileToken` is nullable, and the gate still holds.** `assertTurnstile` verifies a token only
 * when this process holds a secret key of its own, so a developer machine with no key configured accepts
 * the tokenless request that a browser with no site key configured sends. A deployment that has the secret
 * rejects it. The client cannot weaken the gate by omitting the field — it can only fail to help.
 */
export const loginAdmin = {
	type: new GraphQLNonNull(LoginAppType),
	args: {
		email: { type: new GraphQLNonNull(GraphQLString) },
		password: { type: new GraphQLNonNull(GraphQLString) },
		rememberMe: { type: new GraphQLNonNull(GraphQLBoolean) },
		turnstileToken: { type: GraphQLString }
	},
	// `IContextLogin` is koa-utils' two-method view of the cookie jar, and the whole of what this resolver
	// needs: Apollo hands it the entire Koa context (see the `async context()` in src/index.mts) and
	// declaring the narrow half is what stops anything but `setLoginCookies` reading off it. It used to be
	// intersected with koa's `Context` for one reason — the caller's address, which the rate limiter
	// bucketed on. That bucket is gone: `app.proxy` is off, so the address reachable here is nginx's own and
	// metering it metered the whole platform. The per-caller limit is the edge's now, and nothing in this
	// file reads a request property at all.
	async resolve(_: unknown, args: IArgs, ctx: IContextLogin) {
		const { password, rememberMe, turnstileToken } = args
		// Normalized once, here, the same `.trim().toLowerCase()` every write path already applies before
		// storing an address — so the rate-limit bucket below, the `login.email` lookup inside
		// `tryLoginAdmin` and the Redis session hash all agree with what got stored, whatever casing or
		// stray whitespace the caller's keyboard sent.
		const email = args.email.trim().toLowerCase()

		// Before the transaction and before bcrypt: the point of the counter is that a refused caller costs
		// this process one Redis INCR, not a Mongo session plus a 14-round hash comparison.
		await guardPublicLogin({
			bucket: 'loginAdmin',
			email,
			turnstileToken,
			perEmailPerHour: PER_EMAIL_PER_HOUR
		})

		// ⚠️ **Lifted out of the transaction callback, along with the Redis mint and the cookie set that
		// use it.** `session.withTransaction` silently re-invokes its callback on a `TransientTransactionError`
		// (two near-simultaneous logins for the same account can WriteConflict inside `updateAdminLoginStats`),
		// and minting a Redis session or setting a cookie from inside that callback would mint — and set —
		// a second time on every retry. Only the Mongo read and write below stay inside the callback;
		// everything that is not itself transactional runs once, after the transaction has committed.
		// The dummy initial value below is never observable: the happy path always overwrites it via
		// `refreshToken = generateRefreshToken()` before it reaches `setLoginCookies` /
		// `setRedisLoginSessionAdmin`, and the catch path never reaches those calls at all (see the note
		// above `tryCatchRethrow` below).
		// Stryker disable next-line StringLiteral: dead initializer, provably unobservable on any reachable path
		let refreshToken = ''
		// Same reasoning: always overwritten by `accessToken = generateAccessToken()` below
		// before the happy-path `return`, and the catch path never reaches a `return` at all —
		// `tryCatchRethrow` always throws (verified in @axiumine/koa-utils: every branch of
		// `throwIfMongoErr`, and both branches of the `if/else` after it, end in a `throw`).
		// Stryker disable next-line StringLiteral: dead initializer, provably unobservable on any reachable path
		let accessToken = ''
		// Stryker disable next-line ObjectLiteral,StringLiteral: dead initializer, provably unobservable on any reachable path
		let redisData: IRedisDataAdmin = { _id: '', email, tier: TIER.admin }

		const session = await mongoose.startSession()

		try {
			await session.withTransaction(async () => {
				// @fixme koa's checkUserLoginAuthorization checks every requirement, and it runs further down

				const admin = await tryLoginAdmin(email, password, session)

				/*************************
				 * redis data
				 */
				const id = admin._id

				// `tier` is what stops this session from being spent on another tier's service.
				// Every service reads Redis under the same `REDIS_KEY` prefix, so the key alone says
				// nothing about which collection minted it — the discriminator has to be in the hash.
				redisData = {
					_id: id.toString(),
					email,
					tier: TIER.admin
				}

				accessToken = generateAccessToken()
				refreshToken = generateRefreshToken()
				const lastLogin = admin.login.lastLogin ?? null

				await updateAdminLoginStats(id, lastLogin, rememberMe, session)
			})
		} catch (e) {
			// Also unobservable: `tryCatchRethrow` two lines below always throws, so this
			// reassignment can never reach the `return` above — there is no path where the
			// function returns after entering this catch block.
			// Stryker disable next-line StringLiteral: dead reassignment, provably unobservable on any reachable path
			refreshToken = accessToken = ''
			// ⚠️ **Nothing is printed here**. This block opened with a `console.log('catch', e)`,
			// which was a debug print rather than a decision: the caught value on this path is a database
			// error today and carries nothing sensitive, and that is exactly why it went before an edit
			// made it untrue. A failure on the login path has the caller's email address in scope, stdout
			// is a log file, and console output becomes `event.breadcrumbs` on the Sentry event
			// `captureException` builds two lines up. `loginUser.mts` has always had this shape.
			tryCatchRethrow(e as Error | GraphQLError)
		} finally {
			await session.endSession()
		}

		// Only reached once the transaction has committed for good — see the note above `refreshToken`.
		// A retried callback re-runs the read/write above, idempotently; everything below runs exactly once.
		await setRedisLoginSessionAdmin(accessToken, refreshToken, redisData, rememberMe)
		setLoginCookies(ctx, refreshToken)

		return { accessToken, onboardingStep: '', onboardingDone: true }
	}
}
