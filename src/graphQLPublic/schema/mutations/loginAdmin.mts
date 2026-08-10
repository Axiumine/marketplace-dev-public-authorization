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
 * ⚠️ Anyone who knows an operator's address can spend this budget on their behalf, so the number is a
 * lockout risk before it is a defence, and locking out the people who administer the platform is worse than
 * locking out one customer: they are also the ones who would respond to the attack. At 30 it stays out of
 * the way of somebody mistyping a password all morning, while still capping a *distributed* attack on one
 * account — and at `SALT_ROUNDS = 14`, 30 bcrypt verifications an hour is not a search anyone finishes.
 */
const PER_EMAIL_PER_HOUR = 30

/**
 * Logs a platform operator in.
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
		const { email, password, rememberMe, turnstileToken } = args

		// Before the transaction and before bcrypt: the point of the counter is that a refused caller costs
		// this process one Redis INCR, not a Mongo session plus a 14-round hash comparison.
		await guardPublicLogin({
			bucket: 'loginAdmin',
			email: email.trim().toLowerCase(),
			turnstileToken,
			perEmailPerHour: PER_EMAIL_PER_HOUR
		})

		// Never observable: `refreshToken` is not part of the returned object below (only
		// `accessToken`, `onboardingStep` and `onboardingDone` are), and the happy path always
		// overwrites it via `refreshToken = generateRefreshToken()` before it reaches
		// `setLoginCookies` / `setRedisLoginSessionAdmin`. The catch path never reaches those
		// calls at all (see the note above `tryCatchRethrow` below).
		// Stryker disable next-line StringLiteral: dead initializer, provably unobservable on any reachable path
		let refreshToken = ''
		// Same reasoning: always overwritten by `accessToken = generateAccessToken()` below
		// before the happy-path `return`, and the catch path never reaches a `return` at all —
		// `tryCatchRethrow` always throws (verified in @axiumine/koa-utils: every branch of
		// `throwIfMongoErr`, and both branches of the `if/else` after it, end in a `throw`).
		// Stryker disable next-line StringLiteral: dead initializer, provably unobservable on any reachable path
		let accessToken = ''

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
				const redisData: IRedisDataAdmin = {
					_id: id.toString(),
					email,
					tier: TIER.admin
				}

				accessToken = generateAccessToken()
				refreshToken = generateRefreshToken()
				const lastLogin = admin.login.lastLogin ?? null

				await setRedisLoginSessionAdmin(accessToken, refreshToken, redisData)
				await updateAdminLoginStats(id, lastLogin, rememberMe, session)

				setLoginCookies(ctx, refreshToken)
			})
		} catch (e) {
			// Also unobservable: `tryCatchRethrow` two lines below always throws, so this
			// reassignment can never reach the `return` above — there is no path where the
			// function returns after entering this catch block.
			// Stryker disable next-line StringLiteral: dead reassignment, provably unobservable on any reachable path
			refreshToken = accessToken = ''
			console.log('catch', e)
			tryCatchRethrow(e as Error | GraphQLError)
		} finally {
			await session.endSession()
		}

		return { accessToken, onboardingStep: '', onboardingDone: true }
	}
}
