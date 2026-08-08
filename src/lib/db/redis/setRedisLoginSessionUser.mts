import { IRefreshData } from '@axiumine/marketplace-common/others/IRefreshData'
import { IRedisDataUser } from '@axiumine/marketplace-common/others/Redis/IRedisDataUser'
import { setRedisLoginSession } from '@lib/db/redis/setRedisLoginSession.mjs'
import * as dotenv from 'dotenv'

dotenv.config()

export async function setRedisLoginSessionUser(accessToken: string, refreshToken: string, accessTokenRedisData: IRedisDataUser) {
	// See `setRedisLoginSessionAdmin.mts` — the refresh hash carries the tier for the same reason.
	const refreshTokenData: IRefreshData = { _id: accessTokenRedisData._id, tier: accessTokenRedisData.tier }

	await setRedisLoginSession(
		accessToken,
		refreshToken,
		accessTokenRedisData as unknown as Record<string, string>,
		refreshTokenData as unknown as Record<string, string>
	)
}
