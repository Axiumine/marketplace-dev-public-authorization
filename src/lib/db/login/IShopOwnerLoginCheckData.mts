import { Types } from 'mongoose'

export interface IShopOwnerLoginCheckData {
	_id: Types.ObjectId
	login: {
		password: string
		firstLogin?: Date
		lastLogin?: Date
		onboardingStep?: string
		onboardingDone?: boolean
	}
	disabled?: boolean
	deleted?: Date
	/**
	 * BC-03's approval gate, raised by an operator to park the account pending review and `$unset`
	 * when it passes — so the approved state is an absent key, not `false`. Read by
	 * `checkShopOwnerApproval` after the password check and by nothing else on this tier.
	 */
	waitApprov?: boolean
}
