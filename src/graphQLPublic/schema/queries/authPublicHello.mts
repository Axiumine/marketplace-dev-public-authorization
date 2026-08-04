import { GraphQLNonNull } from 'graphql'

import Hello2Type from '../types/Hello2Type.mjs'

export const authPublicHello = {
	description: 'authPublicHello',
	type: new GraphQLNonNull(Hello2Type),
	async resolve() {
		return {
			txt: `Hello from authPublicHello`
		}
	}
}
