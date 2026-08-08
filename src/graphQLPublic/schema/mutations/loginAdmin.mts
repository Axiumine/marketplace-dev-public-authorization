import { IContextLogin } from '@axiumine/koa-utils/graphQL/schema/context/IContextLogin'
import { LoginAppType } from '@axiumine/koa-utils/graphQL/schema/types/LoginAppType'
import { setLoginCookies } from '@axiumine/koa-utils/lib/setLoginCookies'
import { generateAccessToken, generateRefreshToken } from '@axiumine/koa-utils/lib/tokens'
import { tryCatchRethrow } from '@axiumine/koa-utils/lib/tryCatchRethrow'
import { IRedisDataAdmin } from '@axiumine/marketplace-common/others/Redis/IRedisDataAdmin'
import { TIER } from '@axiumine/marketplace-common/others/Tier'
import { tryLoginAdmin } from '@lib/db/login/tryLoginAdmin.mjs'
import { updateAdminLoginStats } from '@lib/db/login/updateAdminLoginStats.mjs'
import { setRedisLoginSessionAdmin } from '@lib/db/redis/setRedisLoginSessionAdmin.mjs'
import { GraphQLBoolean, GraphQLError, GraphQLNonNull, GraphQLString } from 'graphql'
import mongoose from 'mongoose'

interface IArgs {
	email: string
	password: string
	rememberMe: boolean
}

export const loginAdmin = {
	type: new GraphQLNonNull(LoginAppType),
	args: {
		email: { type: new GraphQLNonNull(GraphQLString) },
		password: { type: new GraphQLNonNull(GraphQLString) },
		rememberMe: { type: new GraphQLNonNull(GraphQLBoolean) }
	},
	async resolve(_: unknown, args: IArgs, ctx: IContextLogin) {
		const { email, password, rememberMe } = args

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
