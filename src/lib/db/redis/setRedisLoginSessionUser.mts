import { IRefreshData } from '@axiumine/marketplace-common/others/IRefreshData'
import { newSessionLineage } from '@axiumine/marketplace-common/others/newSessionLineage'
import { IRedisDataUser } from '@axiumine/marketplace-common/others/Redis/IRedisDataUser'
import { setRedisLoginSession } from '@lib/db/redis/setRedisLoginSession.mjs'
import * as dotenv from 'dotenv'

dotenv.config()

export async function setRedisLoginSessionUser(
	accessToken: string,
	refreshToken: string,
	accessTokenRedisData: IRedisDataUser,
	rememberMe: unknown
) {
	// See `setRedisLoginSessionAdmin.mts` — the refresh hash carries the tier and the lineage for the
	// same reasons.
	const refreshTokenData: IRefreshData = {
		_id: accessTokenRedisData._id,
		tier: accessTokenRedisData.tier,
		...newSessionLineage(rememberMe)
	}

	await setRedisLoginSession(
		accessToken,
		refreshToken,
		accessTokenRedisData as unknown as Record<string, string>,
		refreshTokenData
	)
}
