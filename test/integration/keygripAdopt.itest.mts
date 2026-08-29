import { randomBytes } from 'node:crypto'

import { redisClient } from '@axiumine/koa-utils/dataSources/Redis'
import { wrapKeygripKeys } from '@axiumine/marketplace-common/encryption/wrapKeygripKeys'
import { keygripFingerprint } from '@axiumine/marketplace-common/others/keygripFingerprint'
import * as dotenv from 'dotenv'
import type { Server } from 'http'
import Keygrip from 'keygrip'
import mongoose from 'mongoose'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

dotenv.config()

import { SERVICE_NAME, start } from '../../src/index.mts'
import { ITEST_KEYGRIP_KEYS, ITEST_REDIS_KEY } from '../../vitest.keygrip.mts'

/*
 * A rotation reaching a running service (ADR-034), against the real Redis cluster.
 *
 * This is the half of the design that cannot be seen from any unit test: `watchKeygrip` is unit-tested
 * against a fake store, and `index.unit.test.mts` proves the callbacks are wired — but "Redis actually
 * delivers a message on this channel to a duplicated cluster connection, and the process that receives
 * it is signing with the new key a moment later" is a property of the live cluster and of nothing else.
 *
 * The rotation itself is written here rather than called: the mutation that mints it lives in
 * `marketplace-dev-admin-authenticated-resource`, and this service's side of the contract is the record
 * plus the announcement, which is exactly what these lines produce.
 *
 * Its own file because it boots a service and then changes the platform's signing keys underneath it —
 * `index.itest.mts` logs in and reads cookies, and a key swap arriving mid-suite would be an unexplained
 * signature failure there.
 */

const KEYGRIP_KEY = `${ITEST_REDIS_KEY}keygrip`
const HOLDERS_KEY = `${ITEST_REDIS_KEY}keygrip:holders`
const ROTATED_CHANNEL = `${ITEST_REDIS_KEY}keygrip:rotated`

/** The KEK globalSetup minted for this run; the service under test booted with the same one. */
const KEK = Buffer.from(process.env.KEYGRIP_KEK as string, 'base64')

/** What a rotation produces: a new key in front of the ones already verifying cookies. */
const ROTATED_KEYS = [
	{ id: 'k3', material: randomBytes(64).toString('base64'), createdAt: new Date().toISOString() },
	...ITEST_KEYGRIP_KEYS
]

let httpServer: Server
let app: { keys?: unknown }
let keygripWatch: NodeJS.Timeout
let keygripSubscriber: { close(): Promise<unknown> }

/** `app.keys` is typed `Keygrip | string[]` by Koa; this service only ever assigns the first. */
const signing = () => app.keys as Keygrip

/** A holders row, split into the two things it holds. The fingerprint has no `@`; the timestamp does. */
function holderRow(row: string | null | undefined) {
	const at = (row as string).indexOf('@')

	return [(row as string).slice(0, at), (row as string).slice(at + 1)]
}

/** Poll until the process has adopted the key set, or give up after five seconds. */
async function adopted(material: string) {
	const expected = new Keygrip([material], 'sha512').sign('session-cookie')

	for (let attempt = 0; attempt < 200; attempt++) {
		if (signing().sign('session-cookie') === expected) return true
		await new Promise((resolve) => setTimeout(resolve, 25))
	}

	return false
}

beforeAll(async () => {
	const server = await start()
	if (!server) throw new Error('server failed to start against the real Redis cluster / MongoDB')
	httpServer = server.httpServer
	app = server.app
	keygripWatch = server.keygripWatch
	keygripSubscriber = server.keygripSubscriber
})

afterAll(async () => {
	/*
	 * ⚠️ Put back what this file rotated. Every file in the project shares one record, and one of them —
	 * keygripFailure.itest.mts — asserts the version number in the boot refusal it triggers. Leaving the
	 * record at 2 would make that file fail on a message that is perfectly correct, in whichever order
	 * vitest happens to run them.
	 */
	await redisClient.hSet(KEYGRIP_KEY, {
		version: '1',
		wrapped: wrapKeygripKeys(ITEST_KEYGRIP_KEYS, 1, KEK),
		fp: keygripFingerprint(ITEST_KEYGRIP_KEYS)
	})
	await redisClient.hDel(HOLDERS_KEY, SERVICE_NAME)

	clearInterval(keygripWatch)
	await keygripSubscriber.close().catch(() => undefined)
	await new Promise<void>((resolve) => httpServer.close(() => resolve()))
	await redisClient.close()
	await mongoose.disconnect()
})

describe('a rotation announced while the service is running', () => {
	it('boots signing with the seeded key set and says so in the holders table', async () => {
		expect(signing().sign('session-cookie')).toBe(new Keygrip([ITEST_KEYGRIP_KEYS[0].material], 'sha512').sign('session-cookie'))

		// `<fingerprint>@<ISO-8601>` under this service's own name — the row an admin reads to decide
		// whether a rotation has reached everything that signs.
		const [fp, stamp] = holderRow(await redisClient.hGet(HOLDERS_KEY, SERVICE_NAME))

		expect(fp).toBe(keygripFingerprint(ITEST_KEYGRIP_KEYS))
		// A real timestamp, not a placeholder: it is what makes the row a heartbeat, and `keygripStatus`
		// will read it to say how long ago each service was last seen.
		expect(new Date(stamp).toISOString()).toBe(stamp)
	})

	/*
	 * ⚠️ The whole point of ADR-034, end to end: no restart, no redeploy, no environment file. The record
	 * moves, a number goes out on the channel, and a process that was already serving picks up the new key
	 * — while still verifying the cookies it signed a second earlier, which is what keeps a rotation from
	 * logging the platform out.
	 */
	it('adopts the new key without a restart, and keeps verifying what it already signed', async () => {
		const signedBefore = signing().sign('session-cookie')

		await redisClient.hSet(KEYGRIP_KEY, {
			version: '2',
			wrapped: wrapKeygripKeys(ROTATED_KEYS, 2, KEK),
			fp: keygripFingerprint(ROTATED_KEYS)
		})
		await redisClient.publish(ROTATED_CHANNEL, '2')

		expect(await adopted(ROTATED_KEYS[0].material)).toBe(true)

		// The cookies issued before the rotation still verify, at their own index — the grace period is the
		// reason the older keys travel in the record at all.
		expect(signing().index('session-cookie', signedBefore)).toBe(1)
	})

	// And it says so where the admin looks: the row moves to the new fingerprint under the same name,
	// which is how `keygripStatus` will be able to answer "has this landed everywhere yet".
	it('restamps its holders row with the fingerprint it adopted', async () => {
		const [fp] = holderRow(await redisClient.hGet(HOLDERS_KEY, SERVICE_NAME))

		expect(fp).toBe(keygripFingerprint(ROTATED_KEYS))
	})
})
