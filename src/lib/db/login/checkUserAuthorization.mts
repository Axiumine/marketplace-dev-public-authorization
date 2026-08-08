import { throwUnauthorizedError } from '@axiumine/koa-utils/graphQL/throw/throwUnauthorizedError'
import { compareHashAsync } from '@axiumine/koa-utils/lib/hash'
import { IAuthorizationDisDel } from '@axiumine/koa-utils/lib/IAuthorizationDisDel'
import { checkUserAuthorizationDisDel } from '@axiumine/marketplace-common/others/checkUserAuthorizationDisDel'

/**
 * called once the account email has been found in the database
 *
 * @param user
 * @param pwd1
 * @param pwd2
 */
export async function checkUserAuthorization(user: IAuthorizationDisDel, pwd1: string, pwd2: string) {
	// the account is in the shopOwner collection
	//console.log('compare pass 1')
	const ret = await compareHashAsync(pwd1, pwd2)
	//console.log('compare pass 2')

	if (!ret) {
		throw throwUnauthorizedError() //@fixme email carrying loginErrorMsg: the password is the same either way.
	}

	checkUserAuthorizationDisDel(user)
}
