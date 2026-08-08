import { Admin } from '@axiumine/marketplace-common/models/MongoDB/Admin'
import { funUpdateLoginStats } from '@lib/db/login/funUpdateLoginStats.mjs'
import { ClientSession, Types } from 'mongoose'

export async function updateAdminLoginStats(
	id: Types.ObjectId,
	lastLogin: null | Date,
	rememberMe: boolean,
	session: ClientSession
) {
	return funUpdateLoginStats(Admin, id, lastLogin, rememberMe, session)
}
