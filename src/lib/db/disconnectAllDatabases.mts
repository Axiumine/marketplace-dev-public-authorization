import { MongoDBDisconnect } from '@axiumine/koa-utils/dataSources/MongoDB'
import { RedisDisconnect } from '@axiumine/koa-utils/dataSources/Redis'
import * as Sentry from '@sentry/node'

/**
 * Disconnects from all databases and exits the process
 * @param exitCode - The exit code to use when terminating the process
 */
export async function disconnectAllDatabases(exitCode: number = 0): Promise<never> {
	const DISCONNECT_TIMEOUT = 5000 // 5 seconds timeout

	try {
		await Promise.race([
			Promise.all([MongoDBDisconnect(), RedisDisconnect()]),
			new Promise((_, reject) => setTimeout(() => reject(new Error('Database disconnection timeout')), DISCONNECT_TIMEOUT))
		])

		Sentry.captureMessage('All databases disconnected successfully', 'info')
		// Flushed before exit: this is the last statement standing between the SDK's transport and the
		// process ending, so an unflushed event here never leaves the machine.
		await Sentry.flush(2000)
		process.exit(exitCode)
	} catch (e) {
		Sentry.captureException(e, {
			extra: { detail: 'Error during database disconnection' }
		})
		await Sentry.flush(2000)
		process.exit(1)
	}
}
