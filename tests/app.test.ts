import { describe, expect, it } from 'vitest'
import { buildApp } from '../src/app'
import {
  createDatabaseClientsStub,
  createQueueRegistryStub,
  createRedisStub,
  createTestConfig,
} from './helpers/fakes'

async function buildTestApp(ready = true): Promise<Awaited<ReturnType<typeof buildApp>>> {
  return buildApp({
    appConfig: createTestConfig(),
    databaseClients: createDatabaseClientsStub(),
    redis: createRedisStub(),
    queues: createQueueRegistryStub(),
    healthChecks: {
      database: ready
        ? (): Promise<void> => Promise.resolve()
        : (): Promise<void> => Promise.reject(new Error('database unavailable')),
      redis: async (): Promise<void> => {},
    },
  })
}

describe('Fastify app foundation', () => {
  it('boots without listening on a socket', async () => {
    const app = await buildTestApp()
    await app.ready()
    expect(app.hasRoute({ method: 'GET', url: '/health/live' })).toBe(true)
    await app.close()
  })

  it('returns live health without dependency checks', async () => {
    const app = await buildTestApp(false)
    const response = await app.inject({ method: 'GET', url: '/health/live' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      success: true,
      data: { status: 'live' },
    })
    await app.close()
  })

  it('returns ready health when dependencies are available', async () => {
    const app = await buildTestApp(true)
    const response = await app.inject({ method: 'GET', url: '/health/ready' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      success: true,
      data: { status: 'ready' },
    })
    await app.close()
  })

  it('returns clean readiness failure without leaking internals', async () => {
    const app = await buildTestApp(false)
    const response = await app.inject({ method: 'GET', url: '/health/ready' })
    expect(response.statusCode).toBe(503)
    expect(response.body).not.toContain('database unavailable')
    expect(response.json()).toMatchObject({
      success: false,
      error: {
        code: 'FINTRACK_ERR_5030',
        message: 'Service dependencies are not ready',
      },
    })
    await app.close()
  })

  it('strips unknown error internals from API responses', async () => {
    const app = await buildTestApp(true)
    app.get('/test/unknown-error', () => {
      throw new Error('PrismaClientKnownRequestError: secret stack detail')
    })

    const response = await app.inject({ method: 'GET', url: '/test/unknown-error' })
    expect(response.statusCode).toBe(500)
    expect(response.body).not.toContain('PrismaClientKnownRequestError')
    expect(response.body).not.toContain('secret stack detail')
    expect(response.json()).toMatchObject({
      success: false,
      error: {
        code: 'FINTRACK_ERR_5000',
        message: 'Internal server error',
      },
    })
    await app.close()
  })
})
