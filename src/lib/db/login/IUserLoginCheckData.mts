import { Types } from 'mongoose'

/**
 * What `tryLoginUser` projects out of a `user` row.
 *
 * Two divergences from `IShopOwnerLoginCheckData`, both of them the tier's shape rather than an
 * omission: there is no `onboardingStep` / `onboardingDone`, because a customer is not walked through
 * anything after registering, and there *is* an `emailVerify.valid`, because that flag is the only
 * gate between a registered customer and a session. A shop owner's equivalent gate is `waitApprov`,
 * which an operator clears by hand and which this collection deliberately does not have.
 */
export interface IUserLoginCheckData {
	_id: Types.ObjectId
	login: {
		password: string
		firstLogin?: Date
		lastLogin?: Date
	}
	emailVerify?: {
		valid?: boolean
	}
	disabled?: boolean
	deleted?: Date
}
