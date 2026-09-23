import { throwUnauthorizedError } from '@axiumine/koa-utils/graphQL/throw/throwUnauthorizedError'
import { User } from '@axiumine/marketplace-common/models/MongoDB/User'
import { checkUserAuthorization } from '@lib/db/login/checkUserAuthorization.mjs'
import { compareAgainstDummyHash } from '@lib/db/login/compareAgainstDummyHash.mjs'
import { IUserLoginCheckData } from '@lib/db/login/IUserLoginCheckData.mjs'
import { ClientSession } from 'mongoose'

/**
 * Authenticates a customer.
 *
 * `checkUserAuthorization` is reused rather than copied: it takes an `IAuthorizationDisDel`, not a
 * model, so it was already tier-agnostic — it compares the hash and then runs the shared
 * `deleted`/`disabled` gate. Only the lookup and the extra gate below are specific to this tier.
 *
 * ⚠️ **The email-verification gate runs after the password check, deliberately.** Both `deleted` and
 * `disabled` are checked in that order for the same reason and `checkUserAuthorizationDisDel` says so
 * in its comments: an account-state message handed out before a password was supplied tells an
 * attacker the address exists. Ordering it after means the caller must already hold the password to
 * learn anything at all, and even then they learn nothing — the error is the same
 * `throwUnauthorizedError` every other failure on this path returns.
 *
 * That generic error is the reason `userVerifyEmailResend` exists on 4027. A customer who never
 * confirmed cannot be told "confirm your email" here without telling everyone else who is registered,
 * so the frontend's login screen offers the resend unconditionally instead.
 */
export async function tryLoginUser(email: string, password: string, session: ClientSession): Promise<IUserLoginCheckData> {
	const user: IUserLoginCheckData | null = await User.findOne(
		{ 'login.email': email },
		'_id disabled deleted emailVerify.valid login.password login.firstLogin login.lastLogin'
	)
		.session(session)
		.lean()

	if (user === null) {
		// ⚠️ Same wall-clock cost as a real compare, so "no such account" cannot be timed apart from
		// "wrong password" — see `compareAgainstDummyHash`'s own comment.
		await compareAgainstDummyHash(password)
		throw throwUnauthorizedError()
	}

	await checkUserAuthorization(user, password, user.login.password)

	if (!user.emailVerify?.valid) {
		throw throwUnauthorizedError()
	}

	return user
}
