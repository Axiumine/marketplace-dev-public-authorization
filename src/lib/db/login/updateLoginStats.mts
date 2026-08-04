import { funUpdateLoginStats } from '@lib/db/login/funUpdateLoginStats.mjs'
import { ShopOwner } from '@thedoctorweb_agency/marketplace-common/models/MongoDB/ShopOwner'
import { ClientSession, Types } from 'mongoose'

export async function updateLoginStats(id: Types.ObjectId, lastLogin: null | Date, rememberMe: boolean, session: ClientSession) {
	return funUpdateLoginStats(ShopOwner, id, lastLogin, rememberMe, session)
}
