import { throwUnauthorizedError } from '@axiumine/koa-utils/graphQL/throw/throwUnauthorizedError'
import { compareHashAsync } from '@axiumine/koa-utils/lib/hash'
import { IAuthorizationDisDel } from '@axiumine/koa-utils/lib/IAuthorizationDisDel'
import { checkUserAuthorizationDisDel } from '@thedoctorweb_agency/marketplace-common/others/checkUserAuthorizationDisDel'

/**
 * called once the account email has been found in the database
 *
 * @param admin
 * @param pwd1
 * @param pwd2
 */
export async function checkAdminAuthorization(admin: IAuthorizationDisDel, pwd1: string, pwd2: string) {
	// the account is in the operators collection
	//console.log('compare pass 1')
	const ret = await compareHashAsync(pwd1, pwd2)
	//console.log('compare pass 2')

	if (!ret) {
		throw throwUnauthorizedError() //@fixme email carrying loginErrorMsg: the password is the same either way.
	}

	// The admin tier used to stop at the password compare: tryLoginAdmin already projected
	// `disabled deleted` out of the collection and then nothing ever read them, so a suspended or
	// deleted platform operator kept logging in with the right password. This is the same gate the
	// ShopOwner path runs in checkUserAuthorization, and it is deliberately placed AFTER the
	// compare — running it earlier would let a caller who does NOT know the password tell an
	// existing-but-disabled account apart from an unknown one.
	checkUserAuthorizationDisDel(admin)
}
