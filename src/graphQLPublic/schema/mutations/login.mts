import { IContextLogin } from '@axiumine/koa-utils/graphQL/schema/context/IContextLogin'
import { LoginAppType } from '@axiumine/koa-utils/graphQL/schema/types/LoginAppType'
import { makeOnboardingData } from '@axiumine/koa-utils/lib/makeOnboardingData'
import { setLoginCookies } from '@axiumine/koa-utils/lib/setLoginCookies'
import { generateAccessToken, generateRefreshToken } from '@axiumine/koa-utils/lib/tokens'
import { tryCatchRethrow } from '@axiumine/koa-utils/lib/tryCatchRethrow'
import { IRedisDataShopOwner } from '@axiumine/marketplace-common/others/Redis/IRedisDataShopOwner'
import { TIER } from '@axiumine/marketplace-common/others/Tier'
import { guardPublicLogin } from '@lib/access/guardPublicLogin.mjs'
import { tryLoginShopOwner } from '@lib/db/login/tryLoginShopOwner.mjs'
import { updateLoginStats } from '@lib/db/login/updateLoginStats.mjs'
import { setRedisLoginSessionShopOwner } from '@lib/db/redis/setRedisLoginSessionShopOwner.mjs'
import { GraphQLBoolean, GraphQLError, GraphQLNonNull, GraphQLString } from 'graphql'
import mongoose, { Types } from 'mongoose'

interface IArgs {
	email: string
	password: string
	rememberMe: boolean
	turnstileToken?: string
}

/**
 * Per hour, per email address — the only counter this process keeps, the per-address half being
 * nginx's (`mkt_owner_auth`).
 *
 * ⚠️ Anyone who knows a shop owner's address can spend this budget on their behalf, so the number is a
 * lockout risk before it is a defence: set it to 5 and a competitor can keep a shop's owner out of their own
 * back office all day. At 60 it stays out of the way of somebody who genuinely cannot remember which
 * password they used, while still capping a *distributed* attack on one account — and at
 * `SALT_ROUNDS = 14`, 60 bcrypt verifications an hour is not a search anyone finishes.
 */
const PER_EMAIL_PER_HOUR = 60

/**
 * Logs a shop owner in.
 *
 * ⚠️ **`turnstileToken` is nullable, and the gate still holds.** `assertTurnstile` verifies a token only
 * when this process holds a secret key of its own, so a developer machine with no key configured accepts
 * the tokenless request that a browser with no site key configured sends. A deployment that has the secret
 * rejects it. The client cannot weaken the gate by omitting the field — it can only fail to help.
 */
export const login = {
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
			bucket: 'login',
			email: email.trim().toLowerCase(),
			turnstileToken,
			perEmailPerHour: PER_EMAIL_PER_HOUR
		})

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

				await setRedisLoginSessionShopOwner(accessToken, refreshToken, redisData, rememberMe)
				await updateLoginStats(id as Types.ObjectId, lastLogin, rememberMe, session)

				setLoginCookies(ctx, refreshToken)
			})
		} catch (e) {
			// Also unobservable: `tryCatchRethrow` two lines below always throws, so this
			// reassignment can never reach the `return` above — there is no path where the
			// function returns after entering this catch block.
			// Stryker disable next-line StringLiteral: dead reassignment, provably unobservable on any reachable path
			accessToken = ''
			// ⚠️ **Nothing is printed here** (E12-S20). This block opened with a `console.log('catch', e)`,
			// which was a debug print rather than a decision: the caught value on this path is a database
			// error today and carries nothing sensitive, and that is exactly why it went before an edit
			// made it untrue. A failure on the login path has the caller's email address in scope, stdout
			// is a log file, and console output becomes `event.breadcrumbs` on the Sentry event
			// `captureException` builds two lines up. `loginUser.mts` has always had this shape.
			tryCatchRethrow(e as Error | GraphQLError)
		} finally {
			await session.endSession()
		}

		return { onboardingStep, onboardingDone, accessToken }
	}
}
