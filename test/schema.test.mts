import { LoginAppType } from '@axiumine/koa-utils/graphQL/schema/types/LoginAppType'
import { graphql, GraphQLBoolean, GraphQLNonNull, GraphQLObjectType, GraphQLSchema, GraphQLString } from 'graphql'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// MutationsPublic pulls in the login resolvers, which import the Redis datasource at module load.
// This file only asserts schema shape, so the client is stubbed rather than instantiated.
vi.mock('@axiumine/koa-utils/dataSources/Redis', () => ({ redisClient: {} }))

// Imported dynamically inside beforeEach, not with a top-level `import` and not in beforeAll:
// MutationsPublic and QueriesPublic are `new GraphQLObjectType({...})` calls that run at module
// load. A top-level import evaluates them during Vitest's file-collection phase, before any test
// body runs — a mutant there (e.g. the whole config object wiped to `{}`, which graphql-js
// rejects with "Must provide name.") throws during collection, which Stryker cannot attribute to
// any test, so it reports Survived even though the suite plainly breaks. Moving the import into
// beforeAll is not enough either: a beforeAll that throws fails the whole file as one "Failed
// Suite" with every test reported as skipped rather than failed, and Stryker's vitest runner
// still does not count that as a kill (verified empirically — reproducing the `{}` mutant by
// hand showed exactly this: 9 skipped, 0 failed). beforeEach re-runs the import inside each
// test's own execution, so a throw there fails that individual test — confirmed with the same
// hand-reproduced mutant: 9 failed, 0 skipped.
let MutationsPublic: (typeof import('../src/graphQLPublic/schema/mutations.mts'))['default']
let QueriesPublic: (typeof import('../src/graphQLPublic/schema/queries.mts'))['default']
let authPublicHello: (typeof import('../src/graphQLPublic/schema/queries/authPublicHello.mts'))['authPublicHello']
let Hello2Type: (typeof import('../src/graphQLPublic/schema/types/Hello2Type.mts'))['default']
// Same reason as the four above, and not a top-level import next to LoginAppType: this one is defined
// in this repo, so it is instrumented by Stryker while koa-utils' type is not.
let LoginUserType: (typeof import('../src/graphQLPublic/schema/types/LoginUserType.mts'))['LoginUserType']

beforeEach(async () => {
	const mutationsModule = await import('../src/graphQLPublic/schema/mutations.mts')
	const queriesModule = await import('../src/graphQLPublic/schema/queries.mts')
	const authPublicHelloModule = await import('../src/graphQLPublic/schema/queries/authPublicHello.mts')
	const hello2TypeModule = await import('../src/graphQLPublic/schema/types/Hello2Type.mts')
	const loginUserTypeModule = await import('../src/graphQLPublic/schema/types/LoginUserType.mts')

	MutationsPublic = mutationsModule.default
	QueriesPublic = queriesModule.default
	authPublicHello = authPublicHelloModule.authPublicHello
	Hello2Type = hello2TypeModule.default
	LoginUserType = loginUserTypeModule.LoginUserType
})

describe('Hello2Type', () => {
	it('exposes only the txt field, a non-nullable String', () => {
		const fields = Hello2Type.getFields()

		expect(Hello2Type.name).toBe('Hello2Type')
		expect(Object.keys(fields)).toEqual(['txt'])
		expect(fields.txt.type).toBeInstanceOf(GraphQLNonNull)
		expect((fields.txt.type as GraphQLNonNull<typeof GraphQLString>).ofType).toBe(GraphQLString)
	})
})

describe('queries.authPublicHello', () => {
	it('carries the authPublicHello description', () => {
		expect(authPublicHello.description).toBe('authPublicHello')
	})

	it('is of non-nullable Hello2Type', () => {
		expect(authPublicHello.type).toBeInstanceOf(GraphQLNonNull)
		expect((authPublicHello.type as GraphQLNonNull<GraphQLObjectType>).ofType).toBe(Hello2Type)
	})

	it('resolves the greeting text', async () => {
		await expect(authPublicHello.resolve()).resolves.toEqual({ txt: 'Hello from authPublicHello' })
	})
})

describe('QueriesPublic', () => {
	it('is named QueriesPublic and mounts authPublicHello as its only field', () => {
		expect(QueriesPublic.name).toBe('QueriesPublic')
		expect(Object.keys(QueriesPublic.getFields())).toEqual(['authPublicHello'])
	})

	it('runs the query end-to-end', async () => {
		const result = await graphql({
			schema: new GraphQLSchema({ query: QueriesPublic }),
			source: '{ authPublicHello { txt } }'
		})

		expect(result.errors).toBeUndefined()
		expect(result.data).toEqual({ authPublicHello: { txt: 'Hello from authPublicHello' } })
	})
})

describe('LoginUserType', () => {
	it('exposes only the accessToken field, a non-nullable String', () => {
		const fields = LoginUserType.getFields()

		expect(LoginUserType.name).toBe('LoginUserType')
		expect(Object.keys(fields)).toEqual(['accessToken'])
		expect(fields.accessToken.type).toBeInstanceOf(GraphQLNonNull)
		expect((fields.accessToken.type as GraphQLNonNull<typeof GraphQLString>).ofType).toBe(GraphQLString)
	})
})

describe('MutationsPublic', () => {
	it('is named MutationsPublic and mounts one login mutation per tier', () => {
		const fields = MutationsPublic.getFields()

		expect(MutationsPublic.name).toBe('MutationsPublic')
		expect(Object.keys(fields)).toEqual(['login', 'loginAdmin', 'loginUser'])
		expect((fields.login.type as GraphQLNonNull<GraphQLObjectType>).ofType).toBe(LoginAppType)
		expect((fields.loginAdmin.type as GraphQLNonNull<GraphQLObjectType>).ofType).toBe(LoginAppType)
		// Deliberately not LoginAppType: that one carries the onboarding fields a customer has none of.
		expect((fields.loginUser.type as GraphQLNonNull<GraphQLObjectType>).ofType).toBe(LoginUserType)
	})

	// The three tiers take the same credentials and the same Turnstile token; only the collection they
	// authenticate against differs. The expected list is spelled out per tier rather than shared, so that a
	// field silently disappearing from one of the three fails here: a shared prefix assertion would pass
	// just as happily with `turnstileToken` dropped from one login page and kept on the other two.
	it.each([
		['login', ['email', 'password', 'rememberMe', 'turnstileToken']],
		['loginAdmin', ['email', 'password', 'rememberMe', 'turnstileToken']],
		['loginUser', ['email', 'password', 'rememberMe', 'turnstileToken']]
	])('%s takes non-nullable email, password and rememberMe', (name, expected) => {
		const args = Object.fromEntries(MutationsPublic.getFields()[name].args.map((a) => [a.name, a.type]))

		expect(Object.keys(args)).toEqual(expected)
		expect((args.email as GraphQLNonNull<typeof GraphQLString>).ofType).toBe(GraphQLString)
		expect((args.password as GraphQLNonNull<typeof GraphQLString>).ofType).toBe(GraphQLString)
		expect((args.rememberMe as GraphQLNonNull<typeof GraphQLBoolean>).ofType).toBe(GraphQLBoolean)
	})

	// The one described field on this schema — `login` and `loginAdmin` carry no `description` at all,
	// so introspection shows the customer mutation documented and the other two bare. Asserted because
	// a description is the only part of a GraphQL field that no resolver test can reach: it changes
	// nothing at runtime, every behavioural test passes with it emptied, and the SDL a client generates
	// is where it is missed.
	it('describes loginUser', () => {
		expect(MutationsPublic.getFields().loginUser.description).toBe('Log a customer in')
	})

	// ⚠️ Nullable on purpose, and the gate still holds. `assertTurnstile` verifies a token only when this
	// process holds a secret key, so a developer machine with none configured accepts the tokenless
	// request a browser with no site key sends, while a deployment that has the secret rejects it. Making
	// the arg non-nullable would break exactly that setup and buy nothing: a client cannot weaken the gate
	// by omitting the field, it can only fail to help. So the nullability is load-bearing, not an oversight
	// to be "tightened" later.
	it.each(['login', 'loginAdmin', 'loginUser'])('takes turnstileToken as a nullable String on %s', (name) => {
		const args = Object.fromEntries(MutationsPublic.getFields()[name].args.map((a) => [a.name, a.type]))

		expect(args.turnstileToken).toBe(GraphQLString)
	})
})
