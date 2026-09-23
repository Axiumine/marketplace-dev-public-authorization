import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const RedisDisconnect = vi.fn()
const MongoDBDisconnect = vi.fn()
const captureMessage = vi.fn()
const captureException = vi.fn()
const flush = vi.fn()

vi.mock('@axiumine/koa-utils/dataSources/Redis', () => ({ RedisDisconnect }))
vi.mock('@axiumine/koa-utils/dataSources/MongoDB', () => ({ MongoDBDisconnect }))
vi.mock('@sentry/node', () => ({ captureMessage, captureException, flush }))

const { disconnectAllDatabases } = await import('../src/lib/db/disconnectAllDatabases.mts')

// process.exit is neutralized to a no-op: the function has a `never` return type, the no-op
// lets it carry on and the exit code is read from the spy without killing the vitest worker.
let exit: ReturnType<typeof vi.spyOn>

describe('disconnectAllDatabases', () => {
	beforeEach(() => {
		RedisDisconnect.mockReset().mockResolvedValue(undefined)
		MongoDBDisconnect.mockReset().mockResolvedValue(undefined)
		captureMessage.mockReset()
		captureException.mockReset()
		flush.mockReset().mockResolvedValue(true)
		exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
	})

	afterEach(() => {
		vi.restoreAllMocks()
		vi.useRealTimers()
	})

	it('disconnects both datasources, flushes Sentry, then exits with 0 by default', async () => {
		await disconnectAllDatabases()

		expect(RedisDisconnect).toHaveBeenCalledTimes(1)
		expect(MongoDBDisconnect).toHaveBeenCalledTimes(1)
		expect(captureMessage).toHaveBeenCalledWith('All databases disconnected successfully', 'info')
		// B14: the success message is queued by `captureMessage` above, and this is what actually
		// sends it — without it, the event never leaves the process before `process.exit` below tears
		// the transport down. Call order, not just presence: a flush that ran AFTER exit would never
		// observably run at all, since exit is mocked to a no-op that does not stop the test, but a
		// flush moved after the `exit` call in the source would still show up here as a later index.
		expect(flush).toHaveBeenCalledExactlyOnceWith(2000)
		expect(exit).toHaveBeenCalledExactlyOnceWith(0)
		expect(flush.mock.invocationCallOrder[0]).toBeLessThan(exit.mock.invocationCallOrder[0])
	})

	it('propagates the requested exit code', async () => {
		await disconnectAllDatabases(3)

		expect(exit).toHaveBeenCalledExactlyOnceWith(3)
	})

	it('exits with 1 and reports to Sentry, flushed, if Redis fails to disconnect', async () => {
		RedisDisconnect.mockRejectedValueOnce(new Error('redis down'))

		await disconnectAllDatabases()

		expect(captureMessage).not.toHaveBeenCalled()
		expect(captureException).toHaveBeenCalledWith(expect.any(Error), {
			extra: { detail: 'Error during database disconnection' }
		})
		expect(flush).toHaveBeenCalledExactlyOnceWith(2000)
		expect(exit).toHaveBeenCalledExactlyOnceWith(1)
		expect(flush.mock.invocationCallOrder[0]).toBeLessThan(exit.mock.invocationCallOrder[0])
	})

	it('exits with 1 and reports to Sentry if MongoDB fails to disconnect', async () => {
		MongoDBDisconnect.mockRejectedValueOnce(new Error('mongo down'))

		await disconnectAllDatabases()

		expect(captureMessage).not.toHaveBeenCalled()
		expect(captureException).toHaveBeenCalledTimes(1)
		expect(exit).toHaveBeenCalledExactlyOnceWith(1)
	})

	it('exits with 1 if the disconnection exceeds the 5s timeout', async () => {
		vi.useFakeTimers()
		RedisDisconnect.mockReturnValueOnce(new Promise(() => {})) // never resolves

		const pending = disconnectAllDatabases()
		await vi.advanceTimersByTimeAsync(5000)
		await pending

		expect(captureException).toHaveBeenCalledTimes(1)
		expect(captureException.mock.calls[0][0]).toMatchObject({ message: 'Database disconnection timeout' })
		expect(exit).toHaveBeenCalledExactlyOnceWith(1)
	})
})
