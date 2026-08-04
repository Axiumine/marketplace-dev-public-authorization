import { throwUnauthorizedError } from '@axiumine/koa-utils/graphQL/throw/throwUnauthorizedError'
import { compareHashAsync } from '@axiumine/koa-utils/lib/hash'
import { IAuthorizationDisDel } from '@axiumine/koa-utils/lib/IAuthorizationDisDel'
import { checkUserAuthorizationDisDel } from '@thedoctorweb_agency/marketplace-common/others/checkUserAuthorizationDisDel'

/**
 * viene chiamata quando l'email dell'utente è stata trovato nel database
 *
 * @param user
 * @param pwd1
 * @param pwd2
 */
export async function checkUserAuthorization(user: IAuthorizationDisDel, pwd1: string, pwd2: string) {
	// utente è nella collection degli utenti network o virali
	//console.log('compare pass 1')
	const ret = await compareHashAsync(pwd1, pwd2)
	//console.log('compare pass 2')

	if (!ret) {
		throw throwUnauthorizedError() //@fixme email con loginErrorMsg:  anche se fosse utente virale, la password è la stessa.
	}

	checkUserAuthorizationDisDel(user)
}
