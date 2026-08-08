import { throwUnauthorizedError } from '@axiumine/koa-utils/graphQL/throw/throwUnauthorizedError'
import { checkUserAuthorization } from '@lib/db/login/checkUserAuthorization.mjs'
import { IShopOwnerLoginCheckData } from '@lib/db/login/IShopOwnerLoginCheckData.mjs'
import { ShopOwner } from '@thedoctorweb_agency/marketplace-common/models/MongoDB/ShopOwner'
import { ClientSession } from 'mongoose'

/**
 * Try to login not admin user
 * @param email
 * @param password
 * @param session
 */
export async function tryLoginShopOwner(
	email: string,
	password: string,
	session: ClientSession
): Promise<IShopOwnerLoginCheckData> {
	const user: IShopOwnerLoginCheckData | null = await ShopOwner.findOne(
		{ 'login.email': email },
		'_id disabled deleted login.password login.firstLogin login.lastLogin login.onboardingStep login.onboardingDone'
	)
		.session(session)
		.lean()

	if (user === null) {
		throw throwUnauthorizedError()
	}
	await checkUserAuthorization(user, password, user.login.password) // resolves when the password matches, throws otherwise

	return user
}
