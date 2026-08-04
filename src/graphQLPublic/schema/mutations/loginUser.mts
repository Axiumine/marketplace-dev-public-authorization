import { IContextLogin } from '@axiumine/koa-utils/graphQL/schema/context/IContextLogin'
import { setLoginCookies } from '@axiumine/koa-utils/lib/setLoginCookies'
import { generateAccessToken, generateRefreshToken } from '@axiumine/koa-utils/lib/tokens'
import { tryCatchRethrow } from '@axiumine/koa-utils/lib/tryCatchRethrow'
import { tryLoginUser } from '@lib/db/login/tryLoginUser.mjs'
import { updateUserLoginStats } from '@lib/db/login/updateUserLoginStats.mjs'
import { setRedisLoginSessionUser } from '@lib/db/redis/setRedisLoginSessionUser.mjs'
import { IRedisDataUser } from '@thedoctorweb_agency/marketplace-common/others/Redis/IRedisDataUser'
import { TIER } from '@thedoctorweb_agency/marketplace-common/others/Tier'
import { GraphQLBoolean, GraphQLError, GraphQLNonNull, GraphQLString } from 'graphql'
import mongoose, { Types } from 'mongoose'

// Relative, like `authPublicHello.mts` next door: the `@ptypes/*` alias in this repo's tsconfig points
// at `src/graphQLApi/schema/types/*`, a directory that exists in the resource services and not here.
import { LoginUserType } from '../types/LoginUserType.mjs'

interface IArgs {
	email: string
	password: string
	rememberMe: boolean
}

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
 * ⚠️ **No Turnstile and no rate limiter here yet.** Both live on 4027 in front of registration and
 * resend. Adding them to a login resolver is a coordinated change with the frontend that calls it —
 * the token has to be minted by a widget on the form — and the customer frontend does not exist yet;
 * `login` and `loginAdmin` next door are called by two shipped apps that send no token at all, so
 * gating this one alone would leave the tiers inconsistent for no gain. The bcrypt cost at
 * `SALT_ROUNDS = 14` is the only thing currently making a password-guessing flood expensive, and that
 * is not enough — this is the first thing to close when the customer login screen lands.
 */
export const loginUser = {
	description: 'Log a customer in',
	type: new GraphQLNonNull(LoginUserType),
	args: {
		email: { type: new GraphQLNonNull(GraphQLString) },
		password: { type: new GraphQLNonNull(GraphQLString) },
		rememberMe: { type: new GraphQLNonNull(GraphQLBoolean) }
	},
	async resolve(_: unknown, args: IArgs, ctx: IContextLogin) {
		const { email, password, rememberMe } = args

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
