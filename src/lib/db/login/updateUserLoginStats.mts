import { User } from '@axiumine/marketplace-common/models/MongoDB/User'
import { funUpdateLoginStats } from '@lib/db/login/funUpdateLoginStats.mjs'
import { ClientSession, Types } from 'mongoose'

export async function updateUserLoginStats(
	id: Types.ObjectId,
	lastLogin: null | Date,
	rememberMe: boolean,
	session: ClientSession
) {
	return funUpdateLoginStats(User, id, lastLogin, rememberMe, session)
}
