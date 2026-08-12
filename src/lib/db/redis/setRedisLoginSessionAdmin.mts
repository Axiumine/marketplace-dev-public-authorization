import { IRefreshData } from '@axiumine/marketplace-common/others/IRefreshData'
import { newSessionLineage } from '@axiumine/marketplace-common/others/newSessionLineage'
import { IRedisDataAdmin } from '@axiumine/marketplace-common/others/Redis/IRedisDataAdmin'
import { setRedisLoginSession } from '@lib/db/redis/setRedisLoginSession.mjs'
import * as dotenv from 'dotenv'

dotenv.config()

export async function setRedisLoginSessionAdmin(
	accessToken: string,
	refreshToken: string,
	accessTokenRedisData: IRedisDataAdmin,
	rememberMe: unknown
) {
	// The refresh hash carries the tier too, not just the access hash: `refresh` mints a brand-new
	// access session from it, and a tier it cannot read is a tier it would have to guess.
	//
	// ⚠️ The lineage is stamped **here and nowhere else** (E14-S01): this is the only moment a session gets
	// a family, a login date and a cap, and every rotation from here on carries all three forward unchanged.
	// The access hash does not get them — the four writers and `refreshSessionTokens` have to agree on its
	// shape, and it is read by every resource service on every request.
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
