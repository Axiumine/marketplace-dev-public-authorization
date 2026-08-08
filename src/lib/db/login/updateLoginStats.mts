import { ShopOwner } from '@axiumine/marketplace-common/models/MongoDB/ShopOwner'
import { funUpdateLoginStats } from '@lib/db/login/funUpdateLoginStats.mjs'
import { ClientSession, Types } from 'mongoose'

export async function updateLoginStats(id: Types.ObjectId, lastLogin: null | Date, rememberMe: boolean, session: ClientSession) {
	return funUpdateLoginStats(ShopOwner, id, lastLogin, rememberMe, session)
}
