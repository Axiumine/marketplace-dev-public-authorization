import { IRefreshData } from '@axiumine/marketplace-common/others/IRefreshData'
import { IRedisDataShopOwner } from '@axiumine/marketplace-common/others/Redis/IRedisDataShopOwner'
import { setRedisLoginSession } from '@lib/db/redis/setRedisLoginSession.mjs'
import * as dotenv from 'dotenv'

dotenv.config()

export async function setRedisLoginSessionShopOwner(
	accessToken: string,
	refreshToken: string,
	accessTokenRedisData: IRedisDataShopOwner
) {
	// See `setRedisLoginSessionAdmin.mts` — the refresh hash carries the tier for the same reason.
	const refreshTokenData: IRefreshData = { _id: accessTokenRedisData._id, tier: accessTokenRedisData.tier }

	await setRedisLoginSession(
		accessToken,
		refreshToken,
		accessTokenRedisData as unknown as Record<string, string>,
		refreshTokenData as unknown as Record<string, string>
	)
}
