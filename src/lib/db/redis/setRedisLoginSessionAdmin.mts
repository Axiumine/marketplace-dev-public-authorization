import { setRedisLoginSession } from '@lib/db/redis/setRedisLoginSession.mjs'
import { IRefreshData } from '@thedoctorweb_agency/marketplace-common/others/IRefreshData'
import { IRedisDataAdmin } from '@thedoctorweb_agency/marketplace-common/others/Redis/IRedisDataAdmin'
import * as dotenv from 'dotenv'

dotenv.config()

export async function setRedisLoginSessionAdmin(
	accessToken: string,
	refreshToken: string,
	accessTokenRedisData: IRedisDataAdmin
) {
	// The refresh hash carries the tier too, not just the access hash: `refresh` mints a brand-new
	// access session from it, and a tier it cannot read is a tier it would have to guess.
	const refreshTokenData: IRefreshData = { _id: accessTokenRedisData._id, tier: accessTokenRedisData.tier }

	await setRedisLoginSession(
		accessToken,
		refreshToken,
		accessTokenRedisData as unknown as Record<string, string>,
		refreshTokenData as unknown as Record<string, string>
	)
}
