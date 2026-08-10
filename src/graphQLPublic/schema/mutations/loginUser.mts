import { IContextLogin } from '@axiumine/koa-utils/graphQL/schema/context/IContextLogin'
import { setLoginCookies } from '@axiumine/koa-utils/lib/setLoginCookies'
import { generateAccessToken, generateRefreshToken } from '@axiumine/koa-utils/lib/tokens'
import { tryCatchRethrow } from '@axiumine/koa-utils/lib/tryCatchRethrow'
import { IRedisDataUser } from '@axiumine/marketplace-common/others/Redis/IRedisDataUser'
import { TIER } from '@axiumine/marketplace-common/others/Tier'
import { guardPublicLogin } from '@lib/access/guardPublicLogin.mjs'
import { tryLoginUser } from '@lib/db/login/tryLoginUser.mjs'
import { updateUserLoginStats } from '@lib/db/login/updateUserLoginStats.mjs'
import { setRedisLoginSessionUser } from '@lib/db/redis/setRedisLoginSessionUser.mjs'
import { GraphQLBoolean, GraphQLError, GraphQLNonNull, GraphQLString } from 'graphql'
import mongoose, { Types } from 'mongoose'

// Relative, like `authPublicHello.mts` next door: the `@ptypes/*` alias in this repo's tsconfig points
// at `src/graphQLApi/schema/types/*`, a directory that exists in the resource services and not here.
import { LoginUserType } from '../types/LoginUserType.mjs'

interface IArgs {
	email: string
	password: string
	rememberMe: boolean
	turnstileToken?: string
}

/**
 * Per hour, per email address — the only counter this process keeps, the per-address half being
 * nginx's (`mkt_auth`).
 *
 * ⚠️ Anyone who knows a customer's address can spend this budget on their behalf, so the number is a
 * lockout risk before it is a defence: set it to 5 and a stranger can keep somebody out of their own
 * account all day. At 60 it stays out of the way of a person who genuinely cannot remember which
 * password they used, while still capping a *distributed* attack on one account — and at
 * `SALT_ROUNDS = 14`, 60 bcrypt verifications an hour is not a search anyone finishes.
 */
const PER_EMAIL_PER_HOUR = 60

/**
 * Logs a customer in. The third of the three tiers, and the same shape as the other two — role on this
 * platform is which collection you authenticate against, so a third role is a third resolver and a
 * third session namespace, never a `role` field on a shared one.
 *
 * What differs from `login` is the tier stamped into the session hash, the model behind the lookup and
 * the email-verification gate inside `tryLoginUser`; what does not differ is that the session is
 * written to the same `REDIS_KEY` prefix as every other tier's, so the single logout service on 4030
 * keeps working unchanged. `assertTier` on each resource service is what keeps this token out of the
 * ShopOwner and Admin APIs.
 *
 * All three login resolvers are rate-limited and captcha-gated now; this one was first, because
 * `marketplace-user` was the only app minting a Turnstile token when the guard was written. What still
 * differs is the numbers: the ceilings are per-resolver constants, and `loginAdmin` sits lower than these
 * because there are a handful of operator accounts and a stolen operator session is the worst outcome on
 * the platform.
 *
 * ⚠️ **`turnstileToken` is nullable, and the gate still holds.** `assertTurnstile` verifies a token only
 * when this process holds a secret key of its own, so a developer machine with no key configured accepts
 * the tokenless request that a browser with no site key configured sends. A deployment that has the
 * secret rejects it. The client cannot weaken the gate by omitting the field — it can only fail to help.
 */
export const loginUser = {
	description: 'Log a customer in',
	type: new GraphQLNonNull(LoginUserType),
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

		// Before the transaction and before bcrypt: the point of the counter is that a refused caller
		// costs this process one Redis INCR, not a Mongo session plus a 14-round hash comparison.
		await guardPublicLogin({
			bucket: 'loginUser',
			email: email.trim().toLowerCase(),
			turnstileToken,
			perEmailPerHour: PER_EMAIL_PER_HOUR
		})

		// Never observable, exactly as in `login.mts`: the happy path overwrites it before the `return`
		// and the catch path never reaches the `return` at all, because `tryCatchRethrow` always throws.
		// Stryker disable next-line StringLiteral: dead initializer, provably unobservable on any reachable path
		let accessToken = ''

		const session = await mongoose.startSession()

		try {
			await session.withTransaction(async () => {
				const user = await tryLoginUser(email, password, session)

				const id = user._id
				const lastLogin = user.login.lastLogin ?? null

				const redisData: IRedisDataUser = {
					_id: id.toString(),
					email,
					tier: TIER.user
				}

				accessToken = generateAccessToken()
				const refreshToken = generateRefreshToken()

				await setRedisLoginSessionUser(accessToken, refreshToken, redisData, rememberMe)
				await updateUserLoginStats(id as Types.ObjectId, lastLogin, rememberMe, session)

				setLoginCookies(ctx, refreshToken)
			})
		} catch (e) {
			// Same story as the initializer above: unreachable by the `return`, kept so the token never
			// survives a partially-completed transaction in any future rearrangement of this block.
			// Stryker disable next-line StringLiteral: dead reassignment, provably unobservable on any reachable path
			accessToken = ''
			tryCatchRethrow(e as Error | GraphQLError)
		} finally {
			await session.endSession()
		}

		return { accessToken }
	}
}
