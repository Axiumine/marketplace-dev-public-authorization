import { setRedisLoginSession } from '@lib/db/redis/setRedisLoginSession.mjs'
import { IRefreshData } from '@thedoctorweb_agency/marketplace-common/others/IRefreshData'
import { IRedisDataShopOwner } from '@thedoctorweb_agency/marketplace-common/others/Redis/IRedisDataShopOwner'
import * as dotenv from 'dotenv'

dotenv.config()

export async function setRedisLoginSessionShopOwner(
	accessToken: string,
	refreshToken: string,
	accessTokenRedisData: IRedisDataShopOwner
) {
	const refreshTokenData: IRefreshData = { _id: accessTokenRedisData._id }

	await setRedisLoginSession(
		accessToken,
		refreshToken,
		accessTokenRedisData as unknown as Record<string, string>,
		refreshTokenData as unknown as Record<string, string>
	)
}
