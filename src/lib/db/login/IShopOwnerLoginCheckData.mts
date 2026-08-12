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
	 * BC-03's approval gate, raised by an operator to park the account pending review — and by
	 * `shopOwnerRegister`, where a stranger signed themselves up — and `$unset` when it passes, so the
	 * approved state is an absent key, not `false`. Read by `checkShopOwnerApproval` after the password
	 * check and by nothing else on this tier.
	 */
	waitApprov?: boolean
	/**
	 * ⚠️ **Optional, and the gate that reads it turns on `=== false` rather than `!== true`.** The
	 * block is written only by `shopOwnerRegister`: a shop owner an operator created through
	 * `shopOwnerAdd` has no `emailVerify` at all and never will, because there is nothing to backfill
	 * it from. Absent therefore has to mean "not gated on this", and only an explicit `false` — a
	 * self-registration whose activation link has not been opened — refuses the login.
	 */
	emailVerify?: {
		valid?: boolean
	}
}
