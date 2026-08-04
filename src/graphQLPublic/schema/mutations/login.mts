import { IContextLogin } from '@axiumine/koa-utils/graphQL/schema/context/IContextLogin'
import { LoginAppType } from '@axiumine/koa-utils/graphQL/schema/types/LoginAppType'
import { makeOnboardingData } from '@axiumine/koa-utils/lib/makeOnboardingData'
import { setLoginCookies } from '@axiumine/koa-utils/lib/setLoginCookies'
import { generateAccessToken, generateRefreshToken } from '@axiumine/koa-utils/lib/tokens'
import { tryCatchRethrow } from '@axiumine/koa-utils/lib/tryCatchRethrow'
import { tryLoginImprenditore } from '@lib/db/login/tryLoginImprenditore.mjs'
import { updateLoginStats } from '@lib/db/login/updateLoginStats.mjs'
import { setRedisLoginSessionImprenditore } from '@lib/db/redis/setRedisLoginSessionImprenditore.mjs'
import { IRedisDataImprenditore } from '@thedoctorweb_agency/marketplace-common/others/Redis/IRedisDataImprenditore'
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
				// @fixme checkUserLoginAuthorization di koa che controlla tutti i reqirements, che viene fatta dopo sotto
				const user = await tryLoginImprenditore(email, password, session)

				/*************************
				 * redis data
				 */

				const id = user._id
				const lastLogin = user.login.lastLogin ?? null
				const step = makeOnboardingData(user.login)

				const redisData: IRedisDataImprenditore = {
					_id: id.toString(),
					email
				}
				if (step !== null) redisData.onboardingStep = step

				accessToken = generateAccessToken()
				const refreshToken = generateRefreshToken()

				await setRedisLoginSessionImprenditore(accessToken, refreshToken, redisData)
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
