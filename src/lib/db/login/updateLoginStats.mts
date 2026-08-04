import { funUpdateLoginStats } from '@lib/db/login/funUpdateLoginStats.mjs'
import { Imprenditore } from '@thedoctorweb_agency/marketplace-common/models/MongoDB/Imprenditore'
import { ClientSession, Types } from 'mongoose'

export async function updateLoginStats(id: Types.ObjectId, lastLogin: null | Date, rememberMe: boolean, session: ClientSession) {
	return funUpdateLoginStats(Imprenditore, id, lastLogin, rememberMe, session)
}
