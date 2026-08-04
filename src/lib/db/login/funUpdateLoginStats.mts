import { ILoginSet } from '@axiumine/koa-utils/lib/db/login/ILoginSet'
import { ILoginUnset } from '@axiumine/koa-utils/lib/db/login/ILoginUnset'
import { ClientSession, Model, Types } from 'mongoose'

/**
 * Stamps the login counters on whichever tier just authenticated. ShopOwner and Admin keep
 * the very same `login` sub-document, so the two callers differ only by collection — passing
 * the model in keeps one copy of the update.
 */
export async function funUpdateLoginStats<T>(
	model: Model<T>,
	id: Types.ObjectId,
	lastLogin: null | Date,
	rememberMe: boolean,
	session: ClientSession
) {
	const now = new Date()

	// update last login
	const dbSet: ILoginSet = {}
	const dbUnset: ILoginUnset = {}

	// @ts-expect-error dotted update paths: ILoginSet/ILoginUnset model the nested shape
	dbSet['login.lastLogin'] = now

	// set firstLogin if this is the first login.
	if (lastLogin === null) {
		// @ts-expect-error dotted update paths: ILoginSet/ILoginUnset model the nested shape
		dbSet['login.firstLogin'] = now
	} else {
		// not the first login
	}

	if (rememberMe) {
		// @ts-expect-error dotted update paths: ILoginSet/ILoginUnset model the nested shape
		dbSet['login.rememberMe'] = true
	} else {
		// @ts-expect-error dotted update paths: ILoginSet/ILoginUnset model the nested shape
		dbUnset['login.rememberMe'] = 1
	}

	await model.updateOne({ _id: id }, { $set: dbSet, $unset: dbUnset }, { session: session, runValidators: true })
}
