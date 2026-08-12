import { throwUnauthorizedError } from '@axiumine/koa-utils/graphQL/throw/throwUnauthorizedError'
import { ShopOwner } from '@axiumine/marketplace-common/models/MongoDB/ShopOwner'
import { checkShopOwnerApproval } from '@axiumine/marketplace-common/others/checkShopOwnerApproval'
import { checkUserAuthorization } from '@lib/db/login/checkUserAuthorization.mjs'
import { IShopOwnerLoginCheckData } from '@lib/db/login/IShopOwnerLoginCheckData.mjs'
import { ClientSession } from 'mongoose'

/**
 * Authenticates a shop owner.
 *
 * ⚠️ **The approval gate runs after the password check, deliberately** — same placement, and same
 * reasoning, as the email-verification gate in `tryLoginUser` next door: an account-state answer
 * handed out before a password was supplied tells an attacker which addresses are registered and
 * parked. After it, the caller must already hold the password to learn anything, and even then the
 * error is the same `throwUnauthorizedError` every other failure on this path returns.
 *
 * `waitApprov` is projected for that gate and for nothing else. It is BC-03's field: this service
 * reads it, never writes it, and never returns it — it is absent from `IShopOwnerLoginCheckData`'s
 * purpose beyond the gate, and the session minted downstream carries no trace of it. The eslint
 * block in this repo bans it in a write position for that reason.
 *
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
		'_id disabled deleted waitApprov login.password login.firstLogin login.lastLogin login.onboardingStep login.onboardingDone'
	)
		.session(session)
		.lean()

	if (user === null) {
		throw throwUnauthorizedError()
	}
	await checkUserAuthorization(user, password, user.login.password) // resolves when the password matches, throws otherwise

	checkShopOwnerApproval(user)

	return user
}
