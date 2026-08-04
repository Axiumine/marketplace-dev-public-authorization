import http from 'node:http'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const captureException = vi.fn()
const captureMessage = vi.fn()
const RedisConnect = vi.fn()
const MongoDBConnect = vi.fn()
const disconnectAllDatabases = vi.fn()

vi.mock('@sentry/node', () => ({ captureException, captureMessage }))
// redisClient is imported transitively by the login resolvers; a bare stub is enough because the
// unit project never connects — only start()'s failure path is exercised here.
vi.mock('@axiumine/koa-utils/dataSources/Redis', () => ({ RedisConnect, redisClient: {} }))
vi.mock('@axiumine/koa-utils/dataSources/MongoDB', () => ({ MongoDBConnect }))
vi.mock('@lib/db/disconnectAllDatabases.mjs', () => ({ disconnectAllDatabases }))

const {
	ENDPOINT,
	REQUIRED_ENV_VARS,
	checkRequiredEnv,
	buildValidationRules,
	healthResponse,
	logListening,
	gracefulShutdown,
	onUnhandledRejection,
	onUncaughtException,
	start
} = await import('../src/index.mts')

describe('ENDPOINT', () => {
	it('is the /public-authorization path', () => {
		expect(ENDPOINT).toBe('/public-authorization')
	})
})

describe('checkRequiredEnv', () => {
	it('passes when every required variable is set', () => {
		const env = Object.fromEntries(REQUIRED_ENV_VARS.map((k) => [k, 'x']))
		expect(() => checkRequiredEnv(env)).not.toThrow()
	})

	it('throws naming the first missing variable', () => {
		expect(() => checkRequiredEnv({})).toThrow(`Missing required environment variable: ${REQUIRED_ENV_VARS[0]}`)
	})

	// This tier reaches MongoDB directly (the login resolvers read shopOwner/admin), so unlike
	// the authorization services MONGODB_URI is part of the boot contract.
	it('requires MONGODB_URI', () => {
		expect(REQUIRED_ENV_VARS).toContain('MONGODB_URI')
	})
})

describe('buildValidationRules', () => {
	it('is empty outside production', () => {
		expect(buildValidationRules({ NODE_ENV: 'test' })).toEqual([])
	})

	it('caps depth and blocks introspection in production', () => {
		expect(buildValidationRules({ NODE_ENV: 'production' })).toHaveLength(2)
	})
})

describe('healthResponse', () => {
	it('reports OK with a round-trippable ISO timestamp', () => {
		const res = healthResponse()
		expect(res.status).toBe('OK')
		expect(res.timestamp).toBe(new Date(res.timestamp).toISOString())
	})
})

describe('logListening', () => {
	let info: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		captureMessage.mockReset()
		info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
	})
	afterEach(() => {
		info.mockRestore()
		vi.unstubAllEnvs()
	})

	// The real call site in start() invokes logListening() with NO argument at all, falling back
	// to process.env — that is the path that actually shipped `undefined` as the host once
	// HOSTNAME was removed from the env template while the old banner still read it. Exercising
	// the explicit-argument overload alone hid that regression, so this test stubs process.env
	// and calls the function exactly the way production does.
	it('with no argument, builds the banner from process.env, exactly as start() calls it', () => {
		vi.stubEnv('NODE_ENV', 'test')
		vi.stubEnv('PORT', '4028')

		logListening()

		expect(info).toHaveBeenCalledExactlyOnceWith('Serving http://*:4028/public-authorization for test.')
		expect(captureMessage).not.toHaveBeenCalled()
	})

	it('logs to the console only, outside production', () => {
		logListening({ NODE_ENV: 'test', PORT: '4028' })
		expect(info).toHaveBeenCalledExactlyOnceWith('Serving http://*:4028/public-authorization for test.')
		expect(captureMessage).not.toHaveBeenCalled()
	})

	it('also mirrors the banner to Sentry in production, naming every interface with *, never a host', () => {
		logListening({ NODE_ENV: 'production', PORT: '80' })
		// The banner never names a host: the server binds every interface (see start()), so `*`
		// stands in for the address. The expected string is a hardcoded literal, not built from
		// the imported ENDPOINT/PORT, so a mutant that corrupts either still fails this match.
		expect(captureMessage).toHaveBeenCalledExactlyOnceWith('Serving http://*:80/public-authorization for production.', 'info')
		expect(info).toHaveBeenCalledExactlyOnceWith('Serving http://*:80/public-authorization for production.')
	})
})

describe('gracefulShutdown', () => {
	beforeEach(() => {
		captureMessage.mockReset()
		disconnectAllDatabases.mockReset()
	})

	it('drains Apollo, closes the server and disconnects with code 0', async () => {
		const apolloServer = { stop: vi.fn().mockResolvedValue(undefined) }
		const httpServer = { close: vi.fn((cb: () => void) => cb()) }

		await gracefulShutdown('SIGTERM', apolloServer as never, httpServer as never)

		expect(captureMessage).toHaveBeenCalledWith('SIGTERM received, shutting down gracefully...')
		expect(apolloServer.stop).toHaveBeenCalledTimes(1)
		expect(disconnectAllDatabases).toHaveBeenCalledWith(0)
	})
})

describe('process handlers', () => {
	let exit: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		captureException.mockReset()
		exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
	})
	afterEach(() => exit.mockRestore())

	it('onUnhandledRejection reports the reason and exits 1', () => {
		const reason = new Error('boom')
		onUnhandledRejection(reason)
		expect(captureException).toHaveBeenCalledWith(reason)
		expect(exit).toHaveBeenCalledWith(1)
	})

	it('onUncaughtException reports the error and exits 1', () => {
		const error = new Error('kaboom')
		onUncaughtException(error)
		expect(captureException).toHaveBeenCalledWith(error)
		expect(exit).toHaveBeenCalledWith(1)
	})
})

describe('start (failure path)', () => {
	let errorLog: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		captureException.mockReset()
		disconnectAllDatabases.mockReset()
		RedisConnect.mockReset().mockResolvedValue(undefined)
		MongoDBConnect.mockReset().mockResolvedValue(undefined)
		for (const k of REQUIRED_ENV_VARS) vi.stubEnv(k, 'x')
		errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)
	})
	afterEach(() => {
		errorLog.mockRestore()
		vi.unstubAllEnvs()
	})

	it('reports to Sentry and disconnects with code 1 when MongoDB fails to connect', async () => {
		const error = new Error('mongo boom')
		MongoDBConnect.mockRejectedValueOnce(error)

		await start()

		expect(MongoDBConnect).toHaveBeenCalledTimes(1)
		expect(errorLog).toHaveBeenCalledExactlyOnceWith('error', error)
		expect(captureException).toHaveBeenCalledWith(error)
		expect(disconnectAllDatabases).toHaveBeenCalledWith(1)
	})

	// Both datasources are opened by the same Promise.all, so Redis's rejection has to be covered
	// separately — MongoDB resolving is not enough to prove the catch handles either side.
	it('reports to Sentry and disconnects with code 1 when Redis fails to connect', async () => {
		const error = new Error('redis boom')
		RedisConnect.mockRejectedValueOnce(error)

		await start()

		expect(errorLog).toHaveBeenCalledExactlyOnceWith('error', error)
		expect(captureException).toHaveBeenCalledWith(error)
		expect(disconnectAllDatabases).toHaveBeenCalledWith(1)
	})
})

describe('start (success path)', () => {
	let listenSpy: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		captureException.mockReset()
		RedisConnect.mockReset().mockResolvedValue(undefined)
		MongoDBConnect.mockReset().mockResolvedValue(undefined)
		for (const k of REQUIRED_ENV_VARS) vi.stubEnv(k, 'x')
		// listen() itself is stubbed out below, so PORT can stay the same placeholder as every
		// other required var — no socket is ever really opened by this test.
		listenSpy = vi.spyOn(http.Server.prototype, 'listen').mockImplementation(function (this: http.Server, ...args: unknown[]) {
			const callback = args.find((arg): arg is () => void => typeof arg === 'function')
			callback?.()

			return this
		})
	})
	afterEach(() => {
		listenSpy.mockRestore()
		vi.unstubAllEnvs()
	})

	it('passes only { port }, never a host, to listen — binding every interface on purpose', async () => {
		const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)

		const server = await start()

		// The whole point of the fix this asserts: no `host`/`hostname` key travels into listen()
		// at all. Node silently ignores an unrecognised option, so a regression here would not
		// throw — this exact-shape check is the only thing that would catch it.
		expect(listenSpy).toHaveBeenCalledExactlyOnceWith({ port: process.env.PORT }, expect.any(Function))

		await server?.apolloServer.stop()
		info.mockRestore()
	})
})
