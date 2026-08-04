import { redisClient } from '@axiumine/koa-utils/dataSources/Redis'
import { throwInternalError } from '@axiumine/koa-utils/graphQL/throw/throwInternalError'
import { accessTokenExpiry, REFRESH_TOKEN_EXPIRY } from '@axiumine/koa-utils/lib/tokens'
import * as Sentry from '@sentry/node'
import * as dotenv from 'dotenv'

dotenv.config()

export async function setRedisLoginSession(
	accessToken: string,
	refreshToken: string,
	accessTokenKeyData: Record<string, string>,
	refreshTokenData: Record<string, string>
) {
	const keyAccess = `${process.env.REDIS_KEY}access:${accessToken}`
	const keyRefresh = `${process.env.REDIS_KEY}refresh:${refreshToken}`

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
