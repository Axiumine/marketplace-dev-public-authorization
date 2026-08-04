import { GraphQLObjectType } from 'graphql'

import { login } from './mutations/login.mjs'
import { loginAdmin } from './mutations/loginAdmin.mjs'
import { loginUser } from './mutations/loginUser.mjs'

// One mutation per tier, on purpose: role here is which collection you authenticate against, so the
// three differ in their model, their session `tier` and — for `loginUser` only — an email-verification
// gate. A single `login(tier:)` would put that choice in the caller's hands.
const MutationsPublic = new GraphQLObjectType({
	name: 'MutationsPublic',
	fields: { login, loginAdmin, loginUser }
})

export default MutationsPublic
