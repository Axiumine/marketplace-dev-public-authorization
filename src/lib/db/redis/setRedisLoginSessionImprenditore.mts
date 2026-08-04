import { setRedisLoginSession } from '@lib/db/redis/setRedisLoginSession.mjs'
import { IRefreshData } from '@thedoctorweb_agency/marketplace-common/others/IRefreshData'
import { IRedisDataImprenditore } from '@thedoctorweb_agency/marketplace-common/others/Redis/IRedisDataImprenditore'
import * as dotenv from 'dotenv'

dotenv.config()

export async function setRedisLoginSessionImprenditore(
	accessToken: string,
	refreshToken: string,
	accessTokenRedisData: IRedisDataImprenditore
) {
	const refreshTokenData: IRefreshData = { _id: accessTokenRedisData._id }

	await setRedisLoginSession(
		accessToken,
		refreshToken,
		accessTokenRedisData as unknown as Record<string, string>,
		refreshTokenData as unknown as Record<string, string>
	)
}
