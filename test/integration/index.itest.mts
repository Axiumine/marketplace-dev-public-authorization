import { createHash, randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'

import { redisClient } from '@axiumine/koa-utils/dataSources/Redis'
import { REFRESH_TOKEN_EXPIRY } from '@axiumine/koa-utils/lib/tokens'
import { encryptDocument } from '@axiumine/marketplace-common/encryption/encryptDocument'
import {
	ENCRYPTED_FIELDS_ADMIN,
	ENCRYPTED_FIELDS_SHOP_OWNER,
	KEY_ALT_NAME_ADMIN,
	KEY_ALT_NAME_SHOP_OWNER
} from '@axiumine/marketplace-common/encryption/encryptedFields'
import { ALGORITHM_DETERMINISTIC } from '@axiumine/marketplace-common/encryption/EncryptionAlgorithm'
import { encryptValue } from '@axiumine/marketplace-common/encryption/fieldEncryption'
import { isCiphertext } from '@axiumine/marketplace-common/encryption/isCiphertext'
import { indexSession, sessionIndexKey, sessionKey } from '@axiumine/marketplace-common/others/sessionKeys'
import { TIER, Tier } from '@axiumine/marketplace-common/others/Tier'
import bcrypt from '@node-rs/bcrypt'
import type { Server } from 'http'
import mongoose from 'mongoose'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { ENDPOINT, start } from '../../src/index.mts'
import { setRedisLoginSession } from '../../src/lib/db/redis/setRedisLoginSession.mts'

const REDIS_KEY = process.env.REDIS_KEY as string

// accessTokenExpiry() returns floor((random() * 61 + 30) * 60) — a random 30-to-91-minute
// window — so the access TTL can only be asserted as a range. REFRESH_TOKEN_EXPIRY is fixed.
const ACCESS_TTL_MIN = 1800
const ACCESS_TTL_MAX = 5459

// One bcrypt hash is shared by every seeded document; at 14 rounds it costs seconds. The
// rounds mirror marketplace-common's SALT_ROUNDS, which its exports map does not expose.
const PASSWORD = 'Itest!Pwd2026'
const SALT_ROUNDS = 14
let passwordHash: string

let httpServer: Server
let base: string

/** POST a GraphQL document to the real endpoint and return status + parsed body. */
async function gql(query: string, variables?: Record<string, unknown>) {
	const res = await fetch(`${base}${ENDPOINT}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ query, variables })
	})

	return {
		status: res.status,
		// setLoginCookies emits refresh_token + its Keygrip .sig; the session tests below read the
		// token back out of here, because it is never returned in the GraphQL payload.
		setCookie: res.headers.getSetCookie(),
		// tdwKoaErrorHandler answers rejected requests with {message, description}; Apollo answers
		// accepted ones with {data, errors}. One parse covers both shapes.
		json: (await res.json()) as {
			data?: Record<string, unknown>
			errors?: Array<{ message: string }>
			message?: string
			description?: string
		}
	}
}

/****************************************************************************************
 * Seeds. Everything below writes to the real dev database, so every document carries an
 * `itest-…@marketplace.invalid` address and is deleted again in afterAll. Session keys are
 * tracked the same way, so a failing assertion still cannot leave one on the cluster.
 ****************************************************************************************/

const seededDocs: Array<{ collection: 'admin' | 'shopOwner'; _id: mongoose.Types.ObjectId }> = []
const seededKeys: string[] = []

let keygripWatch: NodeJS.Timeout
let keygripSubscriber: { close(): Promise<unknown> }

/** The raw driver handle — only defined once start() has connected. */
function db() {
	return mongoose.connection.db!
}

function itestEmail() {
	return `itest-${randomUUID()}@marketplace.invalid`
}

/** Remember a session key so afterAll removes it even if the test that created it fails. */
function track(key: string) {
	seededKeys.push(key)

	return key
}

/**
 * Inserted with the raw driver rather than the Mongoose model, the platform seeding convention:
 * the insert is then shaped by the collection's own `$jsonSchema` and by nothing else, so a seed
 * cannot inherit whatever the model happens to believe today. That is not hypothetical — the model
 * used to spell `personalData.birth.date` as `date` and carry no `contacts` path at all, both of
 * which the validator refuses under `additionalProperties: false`, so a model write failed outright
 * (fixed in marketplace-common 1.17.0). The raw path was never affected, and will not be by the next
 * drift either.
 *
 * `login` merges into the `login` sub-document (email/password/firstLogin/lastLogin/onboarding…).
 * `extra` merges at the document root — that is where the validator puts `disabled`, `deleted`
 * and `waitApprov` (see marketplace-db-setup's create-shopOwner migration), so a gate test needs
 * this second bucket rather than nesting those fields under `login`.
 */
async function seedShopOwner(login: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
	const email = itestEmail()
	const _id = new mongoose.Types.ObjectId()

	// ⚠️ Encrypted after both override bags are spread in, and before the insert (ADR-029): a caller
	// overriding `login` or a personal field gets its own value encrypted too, and what the
	// collection holds for one is `binData` subtype 6 — a plaintext seed would be a document no
	// resolver on the platform can produce, and `login` would then never find it, since the lookup
	// is by the *deterministic ciphertext* of the address.
	await db()
		.collection('shopOwner')
		.insertOne(
			await encryptDocument(
				{
					_id,
					login: { email, password: passwordHash, ...login },
					personalData: {
						firstName: 'Itest',
						lastName: 'ShopOwner',
						birth: { date: new Date('1980-01-01T00:00:00Z') },
						address: { street: '1 Test Street', postalCode: '01103', city: 'Springfield', province: 'MA' },
						contacts: { mobile: '3900000000', email }
					},
					registeredAt: new Date(),
					...extra
				},
				ENCRYPTED_FIELDS_SHOP_OWNER,
				KEY_ALT_NAME_SHOP_OWNER
			)
		)
	seededDocs.push({ collection: 'shopOwner', _id })

	return { _id, email }
}

/** Same two-bucket shape as seedShopOwner — `extra` for the root-level `disabled`/`deleted`. */
async function seedAdmin(login: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
	const email = itestEmail()
	const _id = new mongoose.Types.ObjectId()

	await db()
		.collection('admin')
		.insertOne(
			await encryptDocument(
				{
					_id,
					login: { email, password: passwordHash, ...login },
					personalData: { firstName: 'Itest', lastName: 'Admin' },
					...extra
				},
				ENCRYPTED_FIELDS_ADMIN,
				KEY_ALT_NAME_ADMIN
			)
		)
	seededDocs.push({ collection: 'admin', _id })

	return { _id, email }
}

/**
 * The Redis counter `guardPublicLogin` keeps, as the running service writes it: one hour, one key,
 * `rl:<bucket>:email:<sha256 of the address>`.
 *
 * ⚠️ **The digest is computed here rather than imported from `marketplace-common`.** Calling the
 * production helper would make this suite agree with it whatever it did, including nothing at all;
 * `createHash` in the test names the algorithm independently, and the key only matches if both
 * sides really do SHA-256.
 *
 * **Nothing has to be drained before a run any more.** The counter used to be keyed on `ctx.ip`,
 * which is one loopback address for the whole suite — so two runs inside an hour shared a budget
 * and the second went red on assertions about credentials, a disabled flag or a session hash. That
 * bucket is gone (the per-address half is nginx's now, `app.proxy` being off). Every seed gets a
 * fresh `itest-<uuid>@marketplace.invalid`, so no two runs, and no two tests, ever share a counter.
 */
function rateLimitEmailKey(bucket: string, email: string) {
	return `${REDIS_KEY}rl:${bucket}:email:${createHash('sha256').update(email).digest('hex')}`
}

/** The refresh token Koa just set, read back out of the Set-Cookie headers. */
function refreshTokenFrom(setCookie: string[]) {
	const header = setCookie.find((cookie) => cookie.startsWith('refresh_token='))
	if (!header) throw new Error('login did not set a refresh_token cookie')

	return header.slice('refresh_token='.length).split(';')[0]
}

beforeAll(async () => {
	const server = await start()
	if (!server) throw new Error('server failed to start against the real Redis cluster / MongoDB')
	httpServer = server.httpServer
	// Both belong to the live key watch (ADR-034), and both have to be handed back for the drain below:
	// the timer is unref'd but still fires while the suite runs, and the subscriber is a second
	// connection nothing else in this file knows about.
	keygripWatch = server.keygripWatch
	keygripSubscriber = server.keygripSubscriber
	const address = httpServer.address() as AddressInfo | null
	if (!address || typeof address === 'string') throw new Error('no TCP address on the booted server')
	base = `http://127.0.0.1:${address.port}`

	passwordHash = await bcrypt.hash(PASSWORD, SALT_ROUNDS)
})

/**
 * Cleanup must never abort halfway. `afterAll` drains MongoDB first and Redis second, so a single
 * failed delete — a cluster MOVED mid-resharding, a handle closed early — would otherwise strand
 * every id and key registered after it, and would skip the Redis drain entirely. Mongo residue is
 * harmless, globalSetup drops and re-migrates the database on the next run; a stranded Redis key
 * sits in the cluster for its whole TTL, which for a refresh session is 90 days.
 */
async function drainSafely(what: string, remove: () => Promise<unknown>) {
	try {
		await remove()
	} catch (error) {
		console.error(`[afterAll] cleanup failed for ${what}:`, error)
	}
}

afterAll(async () => {
	// Drop whatever this run created while the handles are still open: documents first, then
	// any session key. One del per key — this is a cluster, so a multi-key del would CROSSSLOT.
	for (const { collection, _id } of seededDocs) {
		await drainSafely(`${collection} ${_id.toString()}`, () => db().collection(collection).deleteOne({ _id }))
	}
	for (const key of seededKeys) {
		await drainSafely(key, () => redisClient.del(key))
	}

	// The watch first: a poll that fires against a closing client would report an error nobody caused.
	clearInterval(keygripWatch)
	await drainSafely('keygrip subscriber', () => keygripSubscriber.close())

	await new Promise<void>((resolve) => httpServer.close(() => resolve()))
	await redisClient.close()
	await mongoose.disconnect()
})

describe('public-authorization service (integration, real MongoDB + real Redis cluster)', () => {
	// start() is what wires both datasources; asserting the live handles is what makes the rest of
	// this file an integration suite rather than an in-process schema test.
	it('has a live MongoDB connection', () => {
		expect(mongoose.connection.readyState).toBe(1)
	})

	it('has a live Redis cluster connection, round-tripping a key in the isolated namespace', async () => {
		const key = `${REDIS_KEY}ping:${randomUUID()}`

		// EX so this one cannot outlive the run. It is never registered for the afterAll drain, so
		// without a TTL a hard kill — or a throw on the assertion below — strands it on the cluster
		// forever. 60s is far longer than the round trip and short enough to be self-cleaning.
		await redisClient.set(key, 'pong', { EX: 60 })
		expect(await redisClient.get(key)).toBe('pong')

		await redisClient.del(key)
		expect(await redisClient.get(key)).toBeNull()
	})
})

// This is the public tier: no cookie, no bearer token, no introspection code. Every request below
// is anonymous on purpose — login/loginAdmin are exactly what an unauthenticated caller must reach.
describe('GraphQL over HTTP', () => {
	it('serves the query without any credential', async () => {
		const { status, json } = await gql('{ authPublicHello { txt } }')

		expect(status).toBe(200)
		expect(json.errors).toBeUndefined()
		expect(json.data).toEqual({ authPublicHello: { txt: 'Hello from authPublicHello' } })
	})

	// Introspection stays open outside production (buildValidationRules returns no rules), and the
	// schema it reports is the one really assembled in createServer — not a copy rebuilt by a test.
	it('exposes the assembled schema through introspection', async () => {
		const { json } = await gql('{ __schema { queryType { name } mutationType { name } } }')

		expect(json.errors).toBeUndefined()
		expect(json.data).toEqual({
			__schema: { queryType: { name: 'QueriesPublic' }, mutationType: { name: 'MutationsPublic' } }
		})
	})

	it('rejects a GET on the GraphQL endpoint (csrfPrevention / method not allowed)', async () => {
		const res = await fetch(`${base}${ENDPOINT}?query=%7B__typename%7D`)

		expect(res.status).toBeGreaterThanOrEqual(400)
	})
})

// The one request that drives both datasources end to end: the resolver opens a Mongo session,
// reads the shopOwner/admin collection and finds nothing. No document is ever written.
describe('login against the real MongoDB', () => {
	const mutation = `
		mutation Login($email: String!, $password: String!) {
			login(email: $email, password: $password, rememberMe: false) { accessToken }
		}
	`
	const mutationAdmin = `
		mutation LoginAdmin($email: String!, $password: String!) {
			loginAdmin(email: $email, password: $password, rememberMe: false) { accessToken }
		}
	`
	const credentials = { email: `nobody-${randomUUID()}@marketplace.test`, password: 'not-a-password' }

	it('refuses an unknown shopOwner', async () => {
		const { json } = await gql(mutation, credentials)

		expect(json.data?.login ?? null).toBeNull()
		expect(json.errors?.[0].message).toBe('Unauthorized')
	})

	it('refuses an unknown admin', async () => {
		const { json } = await gql(mutationAdmin, credentials)

		expect(json.data?.loginAdmin ?? null).toBeNull()
		expect(json.errors?.[0].message).toBe('Unauthorized')
	})
})

/**
 * The at-rest half of ADR-029, on the one service that has to *find* an account by a personal field.
 *
 * `login` and `loginAdmin` look an account up by email address, and the address in the collection is a
 * ciphertext — so the lookup only works because `login.email` is encrypted **deterministically**: the
 * same address always produces the same bytes, and an equality match on those bytes is an equality
 * match on the address. Everything else here is random, which is why the two seeds' `firstName`
 * ciphertexts differ although both spell `Itest`.
 *
 * That difference is the whole assertion. A field quietly switched from random to deterministic would
 * still round-trip, still pass every other test in this file, and still answer every query correctly —
 * and would have handed anyone with read access to the collection an equality oracle over the personal
 * data. Nothing but a same-value/different-ciphertext check notices.
 */
describe('personal fields at rest', () => {
	it('stores login.email deterministically and every other personal field randomly', async () => {
		const { _id: idShopOwner, email } = await seedShopOwner()
		const { _id: idAdmin } = await seedAdmin()
		const { _id: idAdmin2 } = await seedAdmin()

		const shopOwner = await db().collection('shopOwner').findOne({ _id: idShopOwner })
		const admin = await db().collection('admin').findOne({ _id: idAdmin })
		const admin2 = await db().collection('admin').findOne({ _id: idAdmin2 })

		// Nothing readable survives the write, on either collection.
		expect(isCiphertext(shopOwner?.login.email)).toBe(true)
		expect(isCiphertext(shopOwner?.personalData.contacts.mobile)).toBe(true)
		expect(isCiphertext(shopOwner?.personalData.address.street)).toBe(true)
		expect(isCiphertext(admin?.login.email)).toBe(true)
		expect(isCiphertext(admin?.personalData.firstName)).toBe(true)

		// Deterministic: re-encrypting the plaintext address reproduces the stored bytes exactly, which
		// is what makes `{ 'login.email': <ciphertext> }` a working filter for the login resolvers.
		const emailCiphertext = await encryptValue(email, ALGORITHM_DETERMINISTIC, KEY_ALT_NAME_SHOP_OWNER)

		expect(shopOwner?.login.email).toEqual(emailCiphertext)

		// Random: two admins with the identical `firstName` are stored as different bytes.
		expect(admin?.personalData.firstName).not.toEqual(admin2?.personalData.firstName)

		// The password is NOT encrypted, deliberately — it is already an argon2 hash, and encrypting a
		// hash buys nothing while breaking the one comparison the login path makes.
		expect(isCiphertext(shopOwner?.login.password)).toBe(false)
	})
})

/**
 * The half of a login assertion that is the same on both tiers: a non-empty access token, an access
 * hash holding exactly `_id` + `email` + `tier`, a refresh hash holding `_id` + `tier`, and two TTLs
 * armed *after* their fields — the ordering the source comment warns about, since a key whose TTL was
 * set first would read -1 here. Exact equality on both hashes is the point: an `shopOwner` gets no
 * `onboardingStep` while `makeOnboardingData` returns null, and `IRedisDataAdmin` has no onboarding
 * fields at all, so either tier writing a third key would fail this.
 *
 * ⚠️ `tier` is a parameter rather than a constant because this is the *only* place it is written. All
 * nine services share one `REDIS_KEY` prefix, so a session minted here is findable by every one of
 * them, and each asserts the tier before trusting it. Both hashes carry it: the access hash is what a
 * resource service reads, the refresh hash is what an authorization service reads, and a tier on only
 * one of the two would let the missing half be refreshed into a session with no tier at all — which is
 * refused, correctly, but by then the login has already succeeded and the customer sees a dead app.
 *
 * Registers both keys for the `afterAll` drain and hands them back for whatever the caller checks next.
 */
async function expectSessionOnCluster(
	accessToken: string,
	setCookie: string[],
	_id: mongoose.Types.ObjectId,
	email: string,
	tier: string,
	sessionCapDays: string
) {
	expect(accessToken).not.toBe('')

	const accessKey = track(sessionKey(`access:${accessToken}`))
	const refreshKey = track(sessionKey(`refresh:${refreshTokenFrom(setCookie)}`))

	expect(await redisClient.hGetAll(accessKey)).toEqual({ _id: _id.toHexString(), email, tier })
	/*
	 * ⚠️ **`accessKey` is asserted as the key computed here, not as any 64-hex string.** Asserted against a
	 * real cluster: a session is a pair, and until the refresh half recorded the name of the other, the
	 * only thing that could ever find the access token was the `Authorization` header of the next call —
	 * which a page reload does not send, because an access token lives in memory. A digest of the wrong
	 * value would still be 64 hex characters, would still pass a shape check, and would name nothing.
	 */
	expect(await redisClient.hGetAll(refreshKey)).toEqual({
		_id: _id.toHexString(),
		tier,
		familyId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
		originalLogin: expect.stringMatching(/^\d{13}$/),
		sessionCapDays,
		accessKey
	})
	// A key, never a token: the stored value has to be findable by a reader that never sees the secret.
	expect(accessKey).not.toContain(accessToken)

	// The absolute cap is measured from this stamp, so a clock read on the wrong side of a serialisation
	// would only show up here — a real login has to have been stamped within seconds of this assertion.
	expect(Number((await redisClient.hGetAll(refreshKey)).originalLogin)).toBeGreaterThan(Date.now() - 60_000)

	const accessTtl = await redisClient.ttl(accessKey)
	expect(accessTtl).toBeGreaterThanOrEqual(ACCESS_TTL_MIN - 5)
	expect(accessTtl).toBeLessThanOrEqual(ACCESS_TTL_MAX)
	expect(await redisClient.ttl(refreshKey)).toBeGreaterThan(REFRESH_TOKEN_EXPIRY - 60)

	/*
	 * The account's session index, against a real Redis rather than a mock. The contract being proved is
	 * the one session revocation depends on and no unit test can: the field this login wrote **names a
	 * key that is actually there**. Rebuilding the session key from the field and reading it back is the
	 * whole assertion — a field digested from the wrong value would still be 64 hex characters and would
	 * still look right in every unit test, and would name nothing.
	 */
	const indexKey = track(sessionIndexKey(tier as Tier, _id.toHexString()))
	const index = await redisClient.hGetAll(indexKey)
	const field = refreshKey.slice(REDIS_KEY.length)

	expect(Object.keys(index)).toContain(field)
	expect(JSON.parse(index[field]!)).toEqual({ tier, mintedAt: (await redisClient.hGetAll(refreshKey)).originalLogin })
	expect(await redisClient.hGetAll(`${REDIS_KEY}${field}`)).toEqual(await redisClient.hGetAll(refreshKey))

	// Thirty days, the longer cap, whatever cap this login carries — `sessionCapDays` is a parameter of
	// this helper and the index TTL is not.
	expect(await redisClient.ttl(indexKey)).toBeGreaterThan(2_592_000 - 60)

	/*
	 * ⚠️ **The field's own TTL, and it is a different number from the key's**. The key lives the
	 * longer cap unconditionally; the field lives until *this* login's cap runs out, which is what makes a
	 * session that simply expires disappear from the index without anything having to visit it. The two
	 * being different is the whole point, so this asserts the one the cap decides — a login carrying the
	 * one-day cap must read a day here while the key above still reads thirty.
	 */
	const capSeconds = Number(sessionCapDays) * 86_400
	const [fieldTtl] = await redisClient.hTTL(indexKey, field)

	expect(fieldTtl).toBeLessThanOrEqual(capSeconds)
	expect(fieldTtl).toBeGreaterThan(capSeconds - 60)

	return { accessKey, refreshKey, indexKey }
}

// The login mutations are the only writers of a login session on the whole platform: every other
// service reads back what these two put on the cluster. A mocked Redis proves the resolver called
// hSet; only the live cluster proves the session another service will later find is really there.
describe('login writes a real session on the cluster', () => {
	const mutation = `
		mutation Login($email: String!, $password: String!, $rememberMe: Boolean!) {
			login(email: $email, password: $password, rememberMe: $rememberMe) { accessToken }
		}
	`

	it('stores both hashes, arms both TTLs, and stamps the login counters', async () => {
		const { _id, email } = await seedShopOwner()

		const { json, setCookie } = await gql(mutation, { email, password: PASSWORD, rememberMe: false })
		expect(json.errors).toBeUndefined()

		const { accessToken } = json.data?.login as { accessToken: string }

		// setRedisLoginSessionShopOwner writes the whole IRedisDataShopOwner into the access
		// hash and only the _id into the refresh one.
		await expectSessionOnCluster(accessToken, setCookie, _id, email, TIER.shopOwner, '1')

		// updateLoginStats ran in the same transaction, which therefore really committed.
		// rememberMe: false takes the $unset branch, so the field must not be there at all.
		const doc = await db().collection('shopOwner').findOne({ _id })
		expect(doc?.login.lastLogin).toBeInstanceOf(Date)
		expect(doc?.login.firstLogin).toBeInstanceOf(Date)
		expect(doc?.login.rememberMe).toBeUndefined()
	})

	it('carries onboardingStep into the access hash once onboarding is done', async () => {
		const { _id, email } = await seedShopOwner({ onboardingDone: true, onboardingStep: 'p3' })

		const { json, setCookie } = await gql(mutation, { email, password: PASSWORD, rememberMe: true })
		expect(json.errors).toBeUndefined()

		const { accessToken } = json.data?.login as { accessToken: string }
		const accessKey = track(sessionKey(`access:${accessToken}`))
		track(sessionKey(`refresh:${refreshTokenFrom(setCookie)}`))

		expect(await redisClient.hGetAll(accessKey)).toEqual({
			_id: _id.toHexString(),
			email,
			tier: TIER.shopOwner,
			onboardingStep: 'p3'
		})

		// rememberMe: true takes the $set branch instead.
		const doc = await db().collection('shopOwner').findOne({ _id })
		expect(doc?.login.rememberMe).toBe(true)
	})

	it('refuses a seeded shopOwner whose password does not match', async () => {
		const { email } = await seedShopOwner()

		const { json } = await gql(mutation, { email, password: 'not-the-password', rememberMe: false })

		expect(json.data?.login ?? null).toBeNull()
		expect(json.errors?.[0].message).toBe('Unauthorized')
	})
})

// Both gates run AFTER the password compare (see checkUserAuthorization.mts and tryLoginShopOwner),
// so each seed below uses the real correct password — only the real gate can be what refuses the
// request. A mocked model would just prove the gate function was called with some object; only a real
// document read back through the real projection proves the field really reached it, which for
// `waitApprov` is the entire failure mode: `checkShopOwnerApproval` cannot refuse a flag the
// projection never asked for.
describe('login refuses a disabled, deleted or unapproved shopOwner, even with the correct password', () => {
	const mutation = `
		mutation Login($email: String!, $password: String!) {
			login(email: $email, password: $password, rememberMe: false) { accessToken }
		}
	`

	it('refuses a disabled shopOwner', async () => {
		// ⚠️ The reason travels with the flag because the collection demands it: ADR-044 added
		// `dependencies: { disabled: ['disabledReason'] }` to the shopOwner and user validators, so a seed
		// carrying the flag alone is refused by the server before this gate is ever reached. It rides in
		// the `extra` bucket like `disabled` itself, and is encrypted on the way in with every other
		// personal path, which `seedShopOwner` handles by spreading before it encrypts. `admin` carries no
		// such dependency, which is why the two admin seeds below still pass the flag on its own.
		const { email } = await seedShopOwner({}, { disabled: true, disabledReason: 'itest suspension' })

		const { json } = await gql(mutation, { email, password: PASSWORD })

		expect(json.data?.login ?? null).toBeNull()
		expect(json.errors?.[0].message).toBe('Unauthorized')
	})

	it('refuses a deleted shopOwner', async () => {
		const { email } = await seedShopOwner({}, { deleted: new Date() })

		const { json } = await gql(mutation, { email, password: PASSWORD })

		expect(json.data?.login ?? null).toBeNull()
		expect(json.errors?.[0].message).toBe('Unauthorized')
	})

	// The one this file existed without for as long as the flag did: an admin raising `waitApprov`
	// parks the account, and until `checkShopOwnerApproval` nothing anywhere read it, so the parked
	// shop owner logged in with the correct password exactly like an approved one.
	it('refuses a shopOwner still awaiting approval', async () => {
		const { email } = await seedShopOwner({}, { waitApprov: true })

		const { json } = await gql(mutation, { email, password: PASSWORD })

		expect(json.data?.login ?? null).toBeNull()
		expect(json.errors?.[0].message).toBe('Unauthorized')
	})

	// The other half, and the one a `waitApprov` gate written as `!== false` would fail: approval is an
	// *absent* key, not `false` — `funShopOwnerUpdateStatus` `$unset`s it so the admin queue can be
	// `{ waitApprov: { $exists: true } }`. Every other seed in this file is implicitly this case, but
	// none of them says so, and a gate that locked out every approved shop owner would still leave
	// them green only by accident of what they assert.
	it('admits an approved shopOwner, whose document simply has no waitApprov key', async () => {
		const { _id, email } = await seedShopOwner()

		const seeded = await db().collection('shopOwner').findOne({ _id })
		expect(seeded).not.toHaveProperty('waitApprov')

		const { json } = await gql(mutation, { email, password: PASSWORD })

		expect(json.errors).toBeUndefined()
		expect(json.data?.login.accessToken).toEqual(expect.any(String))
	})
})

// funUpdateLoginStats branches on `lastLogin === null` (see its own comment): only the very first
// login sets `login.firstLogin`; every login after that must leave it alone. Every seed above starts
// from a document with no `login.lastLogin` at all, so those tests can only ever reach the "first
// login" arm — this is the only test in the file that seeds a document which has ALREADY logged in
// once, the one arrangement that can reach the `else` branch for real.
describe('login on a repeat visit (funUpdateLoginStats "not the first login" branch)', () => {
	const mutation = `
		mutation Login($email: String!, $password: String!, $rememberMe: Boolean!) {
			login(email: $email, password: $password, rememberMe: $rememberMe) { accessToken }
		}
	`

	it('leaves firstLogin untouched, refreshes lastLogin, and sets rememberMe', async () => {
		const firstLogin = new Date('2026-01-01T00:00:00.000Z')
		const priorLastLogin = new Date('2026-02-01T00:00:00.000Z')
		const { _id, email } = await seedShopOwner({ firstLogin, lastLogin: priorLastLogin })

		const { json, setCookie } = await gql(mutation, { email, password: PASSWORD, rememberMe: true })
		// `login` mints a refresh session server-side with the 90-day REFRESH_TOKEN_EXPIRY. This test
		// only cares about the login timestamps, but the key exists all the same — register it here,
		// before the assertions, or every run of this test strands one key in the cluster for 90 days.
		track(sessionKey(`refresh:${refreshTokenFrom(setCookie)}`))
		expect(json.errors).toBeUndefined()

		const { accessToken } = json.data?.login as { accessToken: string }
		track(sessionKey(`access:${accessToken}`))

		const doc = await db().collection('shopOwner').findOne({ _id })
		// The $set only touches firstLogin when lastLogin was null on entry — it was not here, so
		// the original timestamp must survive byte-for-byte.
		expect(doc?.login.firstLogin).toEqual(firstLogin)
		expect(doc?.login.lastLogin.getTime()).toBeGreaterThan(priorLastLogin.getTime())
		expect(doc?.login.rememberMe).toBe(true)
	})
})

describe('loginAdmin writes a real session on the cluster', () => {
	const mutation = `
		mutation LoginAdmin($email: String!, $password: String!) {
			loginAdmin(email: $email, password: $password, rememberMe: false) { accessToken }
		}
	`

	it('stores both hashes and arms both TTLs', async () => {
		const { _id, email } = await seedAdmin()

		const { json, setCookie } = await gql(mutation, { email, password: PASSWORD })
		expect(json.errors).toBeUndefined()

		const { accessToken } = json.data?.loginAdmin as { accessToken: string }

		await expectSessionOnCluster(accessToken, setCookie, _id, email, TIER.admin, '1')

		const doc = await db().collection('admin').findOne({ _id })
		expect(doc?.login.lastLogin).toBeInstanceOf(Date)
		expect(doc?.login.firstLogin).toBeInstanceOf(Date)
	})

	// The "unknown admin" case above only exercises tryLoginAdmin's findOne-returns-null branch.
	// This is the other branch a real seeded document can reach: the fetch succeeds and
	// checkAdminAuthorization's own compareHashAsync rejection is what refuses the request.
	it('refuses a seeded admin whose password does not match', async () => {
		const { email } = await seedAdmin()

		const { json } = await gql(mutation, { email, password: 'not-the-password' })

		expect(json.data?.loginAdmin ?? null).toBeNull()
		expect(json.errors?.[0].message).toBe('Unauthorized')
	})
})

/*
 * Regression guard for a real privilege bug this suite caught.
 *
 * checkAdminAuthorization.mts used to compare the password hash and stop there. tryLoginAdmin's
 * projection ('_id disabled deleted login.password login.lastLogin') already fetched `disabled` and
 * `deleted` off the real document, and IAdminLoginCheckData already extended the same
 * IAuthorizationDisDel the shopOwner path gates on — but nothing ever read them back, so a
 * suspended or deleted PLATFORM ADMIN (the highest-privilege tier) kept logging in with the right
 * password. Found by seeding a disabled admin and driving it over real HTTP/Mongo, not by inspection.
 *
 * Both cases below use the real correct password on purpose: the gate runs after the compare, so a
 * refusal here can only come from the disabled/deleted check itself. The Unauthorized message is
 * identical to the unknown-email one, which is the point — the caller cannot tell the two apart.
 */
describe('loginAdmin refuses a disabled or deleted admin, even with the correct password', () => {
	const mutation = `
		mutation LoginAdmin($email: String!, $password: String!) {
			loginAdmin(email: $email, password: $password, rememberMe: false) { accessToken }
		}
	`

	it('refuses a disabled admin', async () => {
		const { email } = await seedAdmin({}, { disabled: true })

		const { json } = await gql(mutation, { email, password: PASSWORD })

		expect(json.data?.loginAdmin ?? null).toBeNull()
		expect(json.errors?.[0].message).toBe('Unauthorized')
	})

	it('refuses a deleted admin', async () => {
		const { email } = await seedAdmin({}, { deleted: new Date() })

		const { json } = await gql(mutation, { email, password: PASSWORD })

		expect(json.data?.loginAdmin ?? null).toBeNull()
		expect(json.errors?.[0].message).toBe('Unauthorized')
	})

	// The refusal must be total: no credential of any kind may survive it. The refresh cookie is
	// written by the same resolver, after the gate — so its absence is the observable proof that
	// nothing was minted. (Asserted through the response rather than by scanning Redis: the client
	// is a cluster, where an unrouted KEYS scan is not a thing.)
	it('sets no refresh cookie for a refused disabled admin', async () => {
		const { email } = await seedAdmin({}, { disabled: true })

		const { setCookie } = await gql(mutation, { email, password: PASSWORD })

		expect(setCookie.find((cookie) => cookie.startsWith('refresh_token='))).toBeUndefined()
	})
})

// Same "not the first login" gap as the shopOwner suite above, exercised for Admin: funUpdateLoginStats
// is the shared function (see funUpdateLoginStats.mts), but the admin login tests so far only ever seed a
// document with no `login.lastLogin`, so only the shopOwner describe block above had reached the
// `else` arm. This also covers rememberMe: true for Admin, which the other admin test hardcodes to false.
describe('loginAdmin on a repeat visit (funUpdateLoginStats "not the first login" branch)', () => {
	const mutation = `
		mutation LoginAdmin($email: String!, $password: String!, $rememberMe: Boolean!) {
			loginAdmin(email: $email, password: $password, rememberMe: $rememberMe) { accessToken }
		}
	`

	it('leaves firstLogin unset, refreshes lastLogin, and sets rememberMe', async () => {
		const priorLastLogin = new Date('2026-02-01T00:00:00.000Z')
		const { _id, email } = await seedAdmin({ lastLogin: priorLastLogin })

		const { json, setCookie } = await gql(mutation, { email, password: PASSWORD, rememberMe: true })
		// Same as the `login` counterpart above: the refresh session is minted whether or not this
		// test looks at it, so it has to be tracked before the first assertion that can throw.
		track(sessionKey(`refresh:${refreshTokenFrom(setCookie)}`))
		expect(json.errors).toBeUndefined()

		const { accessToken } = json.data?.loginAdmin as { accessToken: string }
		track(sessionKey(`access:${accessToken}`))

		const doc = await db().collection('admin').findOne({ _id })
		// lastLogin was already non-null on entry, so the `if (lastLogin === null)` branch that sets
		// firstLogin must NOT run — the field stays absent, exactly as it started.
		expect(doc?.login.firstLogin).toBeUndefined()
		expect(doc?.login.lastLogin.getTime()).toBeGreaterThan(priorLastLogin.getTime())
		expect(doc?.login.rememberMe).toBe(true)
	})
})

// guardPublicLogin has its own unit tests, and so does assertUnderRateLimit. What neither can show is
// that the guard is actually *in front of* the resolver on the wired server, ahead of the database
// lookup — a resolver that imported it and never awaited it would pass both. This block is the
// end-to-end proof, and it runs last because it deliberately exhausts a window the tests above spend.
describe('the login limiter is in front of the resolver on the live server', () => {
	const mutation = `
		mutation LoginAdmin($email: String!, $password: String!, $rememberMe: Boolean!) {
			loginAdmin(email: $email, password: $password, rememberMe: $rememberMe) { accessToken }
		}
	`

	it('answers Too Many Requests for credentials that are otherwise valid', async () => {
		// A seeded admin with the right password: every other reason this mutation can refuse is
		// ruled out, so a refusal here can only be the limiter.
		const { email } = await seedAdmin()
		const adminKey = rateLimitEmailKey('loginAdmin', email)

		// The window is spent by writing the counter rather than by firing thirty logins: each real
		// attempt costs a bcrypt verify at SALT_ROUNDS = 14, and the counter is the only state the
		// guard reads. The value is far above any ceiling this resolver could hold, so the test does
		// not restate a constant that lives in loginAdmin.mts. EX 60 in case the drain never runs.
		//
		// ⚠️ Writing this key is also what proves the shape: a service that hashed differently, or
		// that still keyed on an address, would simply not find the counter and the login would
		// succeed.
		await redisClient.set(adminKey, '1000', { EX: 60 })

		const { json, setCookie } = await gql(mutation, { email, password: PASSWORD, rememberMe: false })

		expect(json.data?.loginAdmin ?? null).toBeNull()
		expect(json.errors?.[0].message).toBe('Too Many Requests')
		// Refused before anything was minted — same observable as the disabled-admin case above.
		expect(setCookie.find((cookie) => cookie.startsWith('refresh_token='))).toBeUndefined()

		await redisClient.del(adminKey)
	})
})

describe('setRedisLoginSession against the live cluster', () => {
	/*
	 * ⚠️ **A whole `IRefreshData`, every field of it.** This fixture used to be `{ _id }` alone, which was
	 * already a session no authorization service would accept — `assertRefreshLineage` refuses one missing
	 * the lineage fields — and it is now a session that cannot even be written: the field TTL counts
	 * down to `originalLogin + sessionCapDays`, and neither of those is a number here. Nothing about the
	 * assertion changes; what changes is that the call being made is one the platform actually makes.
	 */
	it('writes exactly the fields it is handed, on both keys', async () => {
		const _id = new mongoose.Types.ObjectId().toHexString()
		const accessToken = randomUUID()
		const refreshToken = randomUUID()
		const accessKey = track(sessionKey(`access:${accessToken}`))
		const refreshKey = track(sessionKey(`refresh:${refreshToken}`))
		track(sessionIndexKey(TIER.shopOwner, _id))
		const refreshData = {
			_id,
			tier: TIER.shopOwner,
			familyId: randomUUID(),
			originalLogin: `${Date.now()}`,
			sessionCapDays: '1'
		}

		await setRedisLoginSession(accessToken, refreshToken, { _id, email: 'oste@marketplace.test' }, refreshData)

		expect(await redisClient.hGetAll(accessKey)).toEqual({ _id, email: 'oste@marketplace.test' })
		// The fields it is handed, plus the one it is the only place able to add: the key of the access
		// token minted beside this refresh token. Asserted as the exact key, so a login that files the
		// caller's data unchanged fails here rather than hours later as an access token nothing can retire.
		expect(await redisClient.hGetAll(refreshKey)).toEqual({ ...refreshData, accessKey })
		expect(await redisClient.ttl(accessKey)).toBeGreaterThanOrEqual(ACCESS_TTL_MIN - 5)
		expect(await redisClient.ttl(refreshKey)).toBeGreaterThan(REFRESH_TOKEN_EXPIRY - 60)
	})

	// The catch block deletes both keys. An empty field map makes the real HSET fail, which is the
	// only way to watch that cleanup run against the cluster — a mocked client proves nothing here.
	it('removes both keys when the write fails', async () => {
		const accessToken = randomUUID()
		const refreshToken = randomUUID()
		const accessKey = track(sessionKey(`access:${accessToken}`))
		const refreshKey = track(sessionKey(`refresh:${refreshToken}`))

		await expect(setRedisLoginSession(accessToken, refreshToken, {}, {})).rejects.toThrow()

		expect(await redisClient.hGetAll(accessKey)).toEqual({})
		expect(await redisClient.hGetAll(refreshKey)).toEqual({})
	})
})

/*
 * The per-field TTL's bound on stale rows, against a real server rather than a mock, because the bound
 * is a claim about **Redis** and not about this code: the answer to "how many fields can an account's index
 * accumulate that name sessions nobody can use" is *none, by construction*, and the construction is
 * `HEXPIRE`. Rotation and logout unfile what they delete, but a session that is simply never used again
 * passes through neither, and only the field's own TTL removes it. A unit test can prove the command was
 * issued with the right seconds; only the cluster proves the field then actually goes away — and that both
 * `hKeys` and `hTTL` agree it has, which is what session revocation will enumerate and what the admin
 * session console will render.
 *
 * `indexSession` is the writer here rather than a hand-rolled `hSet` + `hExpire`: the number under test is
 * the one the real login path computes, so a mistake in the computation has to show up in this test too.
 */
describe('a session index field expires on its own', () => {
	// One second of remaining cap: a lineage minted a day ago minus a second, under the one-day cap. The
	// arithmetic is the story's own — `originalLogin + sessionCapDays`, and nothing about the key's TTL.
	const ONE_SECOND_LEFT = `${Date.now() - 86_400_000 + 1_000}`

	it('drops a field whose cap has run out, and keeps one whose cap has not', async () => {
		const _id = new mongoose.Types.ObjectId().toHexString()
		const indexKey = track(sessionIndexKey(TIER.shopOwner, _id))
		const expiring = `refresh:${randomUUID()}`
		const living = `refresh:${randomUUID()}`

		await indexSession(redisClient, expiring, {
			_id,
			tier: TIER.shopOwner,
			familyId: randomUUID(),
			originalLogin: ONE_SECOND_LEFT,
			sessionCapDays: '1'
		})
		await indexSession(redisClient, living, {
			_id,
			tier: TIER.shopOwner,
			familyId: randomUUID(),
			originalLogin: `${Date.now()}`,
			sessionCapDays: '30'
		})

		const expiringField = createHash('sha256').update(expiring).digest('hex')
		const livingField = createHash('sha256').update(living).digest('hex')

		expect(await redisClient.hKeys(indexKey)).toEqual(expect.arrayContaining([expiringField, livingField]))

		await new Promise((resolve) => setTimeout(resolve, 2_000))

		// Both readers, because they can disagree: a field can be gone from `hTTL` (-2) while a stale
		// `hKeys` still lists it, and it is `hKeys` that a revocation would iterate.
		const keys = await redisClient.hKeys(indexKey)
		expect(keys).not.toContain(expiringField)
		expect(keys).toContain(livingField)
		expect(await redisClient.hTTL(indexKey, expiringField)).toEqual([-2])

		// The survivor still carries the remainder of its own cap — the field did not merely outlive the
		// other one, it is armed with the thirty days its login is entitled to.
		const [livingTtl] = await redisClient.hTTL(indexKey, livingField)
		expect(livingTtl).toBeLessThanOrEqual(2_592_000)
		expect(livingTtl).toBeGreaterThan(2_592_000 - 60)
	})
})

describe('non-GraphQL routes', () => {
	it('serves /health', async () => {
		const res = await fetch(`${base}/health`)

		expect(res.status).toBe(200)
		const json = (await res.json()) as { status: string; timestamp: string }
		expect(json.status).toBe('OK')
	})

	it('falls through to 404 for an unknown path', async () => {
		const res = await fetch(`${base}/nope`)

		expect(res.status).toBe(404)
	})
})
