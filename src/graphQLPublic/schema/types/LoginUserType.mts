import { GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql'

/**
 * What `loginUser` answers.
 *
 * ⚠️ Not koa-utils' `LoginAppType`, which `login` and `loginAdmin` both return. That one carries
 * `onboardingStep` and `onboardingDone` alongside the token, and a customer has no onboarding — the
 * tier has no multi-step flow to resume and `IRedisDataUserCommon` deliberately has no step field. A
 * shared type would force this resolver to answer `''` and `false` forever, and every customer
 * frontend to read two fields that can never say anything.
 *
 * One field is not a reason to answer a bare `String` instead: the refresh cookie is set as a side
 * effect and the session may grow something the client needs later, and widening an object type is
 * additive where replacing a scalar with one is a breaking schema change.
 */
export const LoginUserType = new GraphQLObjectType({
	name: 'LoginUserType',
	fields: () => ({
		accessToken: { type: new GraphQLNonNull(GraphQLString) }
	})
})
