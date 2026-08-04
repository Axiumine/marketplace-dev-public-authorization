import { GraphQLObjectType } from 'graphql'

import { login } from './mutations/login.mjs'
import { loginAdmin } from './mutations/loginAdmin.mjs'

const MutationsPublic = new GraphQLObjectType({
	name: 'MutationsPublic',
	fields: { login, loginAdmin }
})

export default MutationsPublic
