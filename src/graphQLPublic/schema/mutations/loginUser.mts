import { IContextLogin } from '@axiumine/koa-utils/graphQL/schema/context/IContextLogin'
import { setLoginCookies } from '@axiumine/koa-utils/lib/setLoginCookies'
import { generateAccessToken, generateRefreshToken } from '@axiumine/koa-utils/lib/tokens'
import { tryCatchRethrow } from '@axiumine/koa-utils/lib/tryCatchRethrow'
import { guardPublicLogin } from '@lib/access/guardPublicLogin.mjs'
import { tryLoginUser } from '@lib/db/login/tryLoginUser.mjs'
import { updateUserLoginStats } from '@lib/db/login/updateUserLoginStats.mjs'
import { setRedisLoginSessionUser } from '@lib/db/redis/setRedisLoginSessionUser.mjs'
import { IRedisDataUser } from '@thedoctorweb_agency/marketplace-common/others/Redis/IRedisDataUser'
import { TIER } from '@thedoctorweb_agency/marketplace-common/others/Tier'
import { GraphQLBoolean, GraphQLError, GraphQLNonNull, GraphQLString } from 'graphql'
import { Context } from 'koa'
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
 * Per hour, per source IP. Low, because a legitimate person does not log in twenty times an hour from
 * one address — and because this is the counter that actually costs an attacker something: it caps a
 * single machine walking a password list regardless of how many accounts it spreads the attempts over.
 */
const PER_IP_PER_HOUR = 20

/**
 * Per hour, per email address — and much higher than the per-IP figure on purpose.
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
 * ⚠️ **This is the only one of the three login resolvers that is rate-limited and captcha-gated.**
 * `login` and `loginAdmin` next door are called by two shipped apps that mint no Turnstile token, so
 * gating them is a coordinated frontend change that has not been made; `marketplace-user` mints one, so
 * this resolver can be closed today and is. The inconsistency is knowingly temporary and the fix for the
 * other two is the same three lines plus a widget on each form. Until then, bcrypt at `SALT_ROUNDS = 14`
 * is all that makes a password-guessing flood expensive on those two, and that is not enough.
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
	// `IContextLogin` is koa-utils' two-method view of the cookie jar and carries no `ip`, which the rate
	// limiter buckets on. The value Apollo hands every resolver here is the whole Koa context (see the
	// `async context()` in src/index.mts), so the intersection is a widening of the type to what is
	// already being passed, not a cast — `setLoginCookies` keeps type-checking against the narrow half.
	async resolve(_: unknown, args: IArgs, ctx: Context & IContextLogin) {
		const { email, password, rememberMe, turnstileToken } = args

		// Before the transaction and before bcrypt: the point of the counter is that a refused caller
		// costs this process one Redis INCR, not a Mongo session plus a 14-round hash comparison.
		await guardPublicLogin(ctx, {
			bucket: 'loginUser',
			email: email.trim().toLowerCase(),
			turnstileToken,
			perIpPerHour: PER_IP_PER_HOUR,
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

				await setRedisLoginSessionUser(accessToken, refreshToken, redisData)
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
