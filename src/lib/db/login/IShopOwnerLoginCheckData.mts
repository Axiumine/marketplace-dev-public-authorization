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
}
