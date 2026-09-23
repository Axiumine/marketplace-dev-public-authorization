import { throwUnauthorizedError } from '@axiumine/koa-utils/graphQL/throw/throwUnauthorizedError'
import { Admin } from '@axiumine/marketplace-common/models/MongoDB/Admin'
import { checkAdminAuthorization } from '@lib/db/login/checkAdminAuthorization.mjs'
import { compareAgainstDummyHash } from '@lib/db/login/compareAgainstDummyHash.mjs'
import { IAdminLoginCheckData } from '@lib/db/login/IAdminLoginCheckData.mjs'
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
		// ⚠️ Same wall-clock cost as a real compare, so "no such account" cannot be timed apart from
		// "wrong password" — see `compareAgainstDummyHash`'s own comment.
		await compareAgainstDummyHash(password)
		throw throwUnauthorizedError()
	}
	// `admin` first: the disabled/deleted gate inside needs the projected flags, which is why the
	// projection above selects them. Mirrors tryLoginShopOwner/checkUserAuthorization.
	await checkAdminAuthorization(admin, password, admin.login.password) // resolves when the password matches, throws otherwise

	return admin
}
