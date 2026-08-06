import { funUpdateLoginStats } from '@lib/db/login/funUpdateLoginStats.mjs'
import { User } from '@thedoctorweb_agency/marketplace-common/models/MongoDB/User'
import { ClientSession, Types } from 'mongoose'

export async function updateUserLoginStats(
	id: Types.ObjectId,
	lastLogin: null | Date,
	rememberMe: boolean,
	session: ClientSession
) {
	return funUpdateLoginStats(User, id, lastLogin, rememberMe, session)
}
