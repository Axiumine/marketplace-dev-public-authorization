import { throwUnauthorizedError } from '@axiumine/koa-utils/graphQL/throw/throwUnauthorizedError'
import { ShopOwner } from '@axiumine/marketplace-common/models/MongoDB/ShopOwner'
import { checkShopOwnerApproval } from '@axiumine/marketplace-common/others/checkShopOwnerApproval'
import { checkShopOwnerEmailVerified } from '@axiumine/marketplace-common/others/checkShopOwnerEmailVerified'
import { checkUserAuthorization } from '@lib/db/login/checkUserAuthorization.mjs'
import { compareAgainstDummyHash } from '@lib/db/login/compareAgainstDummyHash.mjs'
import { IShopOwnerLoginCheckData } from '@lib/db/login/IShopOwnerLoginCheckData.mjs'
import { ClientSession } from 'mongoose'

/**
 * Authenticates a shop owner.
 *
 * ⚠️ **Both account-state gates run after the password check, deliberately** — same placement, and
 * same reasoning, as the email-verification gate in `tryLoginUser` next door: an account-state answer
 * handed out before a password was supplied tells an attacker which addresses are registered, parked
 * or pending activation. After it, the caller must already hold the password to learn anything, and
 * even then the error is the same `throwUnauthorizedError` every other failure on this path returns.
 *
 * ⚠️ **The two gates are not redundant and their order is not arbitrary.** Every self-registration
 * carries both flags — `waitApprov` up and `emailVerify.valid` false — and they come down at
 * different moments and by different hands: the activation link clears the second, an admin
 * clears the first. Verification is checked first because it is the one the person at the keyboard
 * can act on; whichever throws, the caller sees the same error, so the ordering is a matter of which
 * failure the logs attribute rather than of what is disclosed.
 *
 * `waitApprov` and `emailVerify.valid` are projected for those gates and for nothing else. `waitApprov`
 * is BC-03's field: this service reads it, never writes it, and never returns it — the session minted
 * downstream carries no trace of it, and the eslint block in this repo bans it in a write position for
 * that reason.
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
		'_id disabled deleted waitApprov emailVerify.valid login.password login.firstLogin login.lastLogin login.onboardingStep login.onboardingDone'
	)
		.session(session)
		.lean()

	if (user === null) {
		// ⚠️ Same wall-clock cost as a real compare, so "no such account" cannot be timed apart from
		// "wrong password" — see `compareAgainstDummyHash`'s own comment.
		await compareAgainstDummyHash(password)
		throw throwUnauthorizedError()
	}
	await checkUserAuthorization(user, password, user.login.password) // resolves when the password matches, throws otherwise

	checkShopOwnerEmailVerified(user)

	checkShopOwnerApproval(user)

	return user
}
