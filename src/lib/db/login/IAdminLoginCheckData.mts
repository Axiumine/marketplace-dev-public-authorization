import { IAuthorizationDisDel } from '@axiumine/koa-utils/lib/IAuthorizationDisDel'
import { Types } from 'mongoose'

export interface IAdminLoginCheckData extends IAuthorizationDisDel {
	_id: Types.ObjectId
	login: {
		password: string
		lastLogin?: Date
	}
}
