import { redisClient } from '@axiumine/koa-utils/dataSources/Redis'
import { throwInternalError } from '@axiumine/koa-utils/graphQL/throw/throwInternalError'
import { accessTokenExpiry, REFRESH_TOKEN_EXPIRY } from '@axiumine/koa-utils/lib/tokens'
import { IRefreshData } from '@axiumine/marketplace-common/others/IRefreshData'
import { indexSession, sessionKey } from '@axiumine/marketplace-common/others/sessionKeys'
import * as Sentry from '@sentry/node'
import * as dotenv from 'dotenv'

dotenv.config()

export async function setRedisLoginSession(
	accessToken: string,
	refreshToken: string,
	accessTokenKeyData: Record<string, string>,
	refreshTokenData: IRefreshData
) {
	// Digests, not tokens (E13-S01), and of the **prefixed** value: `access:` and `refresh:` are what every
	// reader presents, so hashing the bare uuid here would mint a session nothing on the platform can find.
	// Writes are hashed-only from the cutover deploy — only reads carry a raw-key fallback, which is what
	// lets the old shape drain instead of growing.
	const keyAccess = sessionKey(`access:${accessToken}`)
	// Built once and kept: the session key and the account index both hash this exact string, and an index
	// field that is the digest of anything else names a key no revocation can rebuild (E15-S02).
	const prefixedRefresh = `refresh:${refreshToken}`
	const keyRefresh = sessionKey(prefixedRefresh)

	try {
		const accTokenExp = accessTokenExpiry()

		// Store session in Redis
		await Promise.all([
			redisClient.hSet(keyAccess, accessTokenKeyData),
			redisClient.hSet(keyRefresh, refreshTokenData as unknown as Record<string, string>)
		])
		// set expire after hSet !
		await Promise.all([redisClient.expire(keyAccess, accTokenExp), redisClient.expire(keyRefresh, REFRESH_TOKEN_EXPIRY)])

		// File the session under its account, so the account can enumerate its own sessions without a
		// keyspace scan (E15-S02). Last, and inside the try: a login whose session cannot be listed is a
		// login that cannot be revoked, so it fails the login rather than half-making one.
		//
		// ⚠️ The rollback below deletes the two session keys and not this field. What it would leave is a
		// row naming two keys that no longer exist — a stale listing, never a credential — and E15-S03's
		// per-field TTL is what removes it. Deleting it here would put a second failure mode on an error
		// path for state that grants nothing.
		await indexSession(redisClient, prefixedRefresh, refreshTokenData)
	} catch (e) {
		// delete keys
		await Promise.all([redisClient.del(keyAccess), redisClient.del(keyRefresh)])
		Sentry.captureException(e)
		throw throwInternalError()
	}
}
