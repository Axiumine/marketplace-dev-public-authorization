import { IContextLogin } from '@axiumine/koa-utils/graphQL/schema/context/IContextLogin'
import { LoginAppType } from '@axiumine/koa-utils/graphQL/schema/types/LoginAppType'
import { makeOnboardingData } from '@axiumine/koa-utils/lib/makeOnboardingData'
import { setLoginCookies } from '@axiumine/koa-utils/lib/setLoginCookies'
import { generateAccessToken, generateRefreshToken } from '@axiumine/koa-utils/lib/tokens'
import { tryCatchRethrow } from '@axiumine/koa-utils/lib/tryCatchRethrow'
import { IRedisDataShopOwner } from '@axiumine/marketplace-common/others/Redis/IRedisDataShopOwner'
import { TIER } from '@axiumine/marketplace-common/others/Tier'
import { tryLoginShopOwner } from '@lib/db/login/tryLoginShopOwner.mjs'
import { updateLoginStats } from '@lib/db/login/updateLoginStats.mjs'
import { setRedisLoginSessionShopOwner } from '@lib/db/redis/setRedisLoginSessionShopOwner.mjs'
import { GraphQLBoolean, GraphQLError, GraphQLNonNull, GraphQLString } from 'graphql'
import mongoose, { Types } from 'mongoose'

interface IArgs {
	email: string
	password: string
	rememberMe: boolean
}

export const login = {
	type: new GraphQLNonNull(LoginAppType),
	args: {
		email: { type: new GraphQLNonNull(GraphQLString) },
		password: { type: new GraphQLNonNull(GraphQLString) },
		rememberMe: { type: new GraphQLNonNull(GraphQLBoolean) }
	},
	async resolve(_: unknown, args: IArgs, ctx: IContextLogin) {
		const { email, password, rememberMe } = args

		let onboardingStep = ''
		let onboardingDone = false
		// This initial value is never observable: the happy path always overwrites it via
		// `accessToken = generateAccessToken()` below before the `return`, and the catch path
		// below never reaches the `return` at all — `tryCatchRethrow` always throws (every
		// branch of `throwIfMongoErr`, and both branches of the `if/else` after it, end in a
		// `throw`; verified by reading its implementation in @axiumine/koa-utils).
		// Stryker disable next-line StringLiteral: dead initializer, provably unobservable on any reachable path
		let accessToken = ''

		const session = await mongoose.startSession()

		try {
			await session.withTransaction(async () => {
				// @fixme koa's checkUserLoginAuthorization checks every requirement, and it runs further down
				const user = await tryLoginShopOwner(email, password, session)

				/*************************
				 * redis data
				 */

				const id = user._id
				const lastLogin = user.login.lastLogin ?? null
				const step = makeOnboardingData(user.login)

				// See `loginAdmin.mts` for why the tier has to be written into the session hash.
				const redisData: IRedisDataShopOwner = {
					_id: id.toString(),
					email,
					tier: TIER.shopOwner
				}
				if (step !== null) redisData.onboardingStep = step

				accessToken = generateAccessToken()
				const refreshToken = generateRefreshToken()

				await setRedisLoginSessionShopOwner(accessToken, refreshToken, redisData)
				await updateLoginStats(id as Types.ObjectId, lastLogin, rememberMe, session)

				setLoginCookies(ctx, refreshToken)
			})
		} catch (e) {
			// Also unobservable: `tryCatchRethrow` two lines below always throws, so this
			// reassignment can never reach the `return` above — there is no path where the
			// function returns after entering this catch block.
			// Stryker disable next-line StringLiteral: dead reassignment, provably unobservable on any reachable path
			accessToken = ''
			console.log('catch', e)
			tryCatchRethrow(e as Error | GraphQLError)
		} finally {
			await session.endSession()
		}

		return { onboardingStep, onboardingDone, accessToken }
	}
}
