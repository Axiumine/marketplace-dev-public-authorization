import { redisClient } from '@axiumine/koa-utils/dataSources/Redis'
import { throwInternalError } from '@axiumine/koa-utils/graphQL/throw/throwInternalError'
import { accessTokenExpiry, REFRESH_TOKEN_EXPIRY } from '@axiumine/koa-utils/lib/tokens'
import { sessionKey } from '@axiumine/marketplace-common/others/sessionKeys'
import * as Sentry from '@sentry/node'
import * as dotenv from 'dotenv'

dotenv.config()

export async function setRedisLoginSession(
	accessToken: string,
	refreshToken: string,
	accessTokenKeyData: Record<string, string>,
	refreshTokenData: Record<string, string>
) {
	// Digests, not tokens (E13-S01), and of the **prefixed** value: `access:` and `refresh:` are what every
	// reader presents, so hashing the bare uuid here would mint a session nothing on the platform can find.
	// Writes are hashed-only from the cutover deploy — only reads carry a raw-key fallback, which is what
	// lets the old shape drain instead of growing.
	const keyAccess = sessionKey(`access:${accessToken}`)
	const keyRefresh = sessionKey(`refresh:${refreshToken}`)

	try {
		const accTokenExp = accessTokenExpiry()

		// Store session in Redis
		await Promise.all([redisClient.hSet(keyAccess, accessTokenKeyData), redisClient.hSet(keyRefresh, refreshTokenData)])
		// set expire after hSet !
		await Promise.all([redisClient.expire(keyAccess, accTokenExp), redisClient.expire(keyRefresh, REFRESH_TOKEN_EXPIRY)])
	} catch (e) {
		// delete keys
		await Promise.all([redisClient.del(keyAccess), redisClient.del(keyRefresh)])
		Sentry.captureException(e)
		throw throwInternalError()
	}
}
