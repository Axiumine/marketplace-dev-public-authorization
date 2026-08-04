import { GraphQLObjectType } from 'graphql'

import { authPublicHello } from './queries/authPublicHello.mjs'

const QueriesPublic = new GraphQLObjectType({
	name: 'QueriesPublic',
	fields: {
		authPublicHello
	}
})

export default QueriesPublic
