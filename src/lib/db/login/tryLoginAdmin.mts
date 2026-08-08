import { throwUnauthorizedError } from '@axiumine/koa-utils/graphQL/throw/throwUnauthorizedError'
import { checkAdminAuthorization } from '@lib/db/login/checkAdminAuthorization.mjs'
import { IAdminLoginCheckData } from '@lib/db/login/IAdminLoginCheckData.mjs'
import { Admin } from '@thedoctorweb_agency/marketplace-common/models/MongoDB/Admin'
import { ClientSession } from 'mongoose'

/**
 * Try to login not admin user
 * @param email
 * @param password
 * @param session
 */
export async function tryLoginAdmin(email: string, password: string, session: ClientSession): Promise<IAdminLoginCheckData> {
	const admin: IAdminLoginCheckData | null = await Admin.findOne(
		{ 'login.email': email },
		'_id disabled deleted login.password login.lastLogin'
	)
		.session(session)
		.lean()

	if (admin === null) {
		throw throwUnauthorizedError()
	}
	// `admin` first: the disabled/deleted gate inside needs the projected flags, which is why the
	// projection above selects them. Mirrors tryLoginShopOwner/checkUserAuthorization.
	await checkAdminAuthorization(admin, password, admin.login.password) // resolves when the password matches, throws otherwise

	return admin
}
