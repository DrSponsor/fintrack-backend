import { describe, expect, it } from 'vitest'
import type { FastifyRequest, FastifyReply } from 'fastify'
import { buildApp } from '../src/app'
import { signAccessToken } from '../src/core/crypto/tokens'
import type { AccessTokenPayload } from '../src/core/crypto/tokens'
import { ERROR_CODES } from '../src/core/errors/codes'
import { unauthenticated } from '../src/core/errors/factories'
import {
  createDatabaseClientsStub,
  createQueueRegistryStub,
  createRedisStub,
  createTestConfig,
  FakeRedis,
} from './helpers/fakes'
import type { AppConfig } from '../src/config'
import { generateKeyPairSync } from 'node:crypto'

// ──────────────────────────────────────────────────────────────────
// Shared test infrastructure
// ──────────────────────────────────────────────────────────────────

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})

function testConfig(): AppConfig {
  return createTestConfig({
    JWT_PUBLIC_KEY_PEM: publicKey,
    JWT_PRIVATE_KEY_PEM: privateKey,
  })
}

function basePayload(overrides: Partial<AccessTokenPayload> = {}): AccessTokenPayload {
  return {
    sub: '00000000-0000-0000-0000-000000000001',
    email: 'test@fintrack.ng',
    role: 'user',
    tier: 'FREE',
    ...overrides,
  }
}

async function createToken(
  payload: AccessTokenPayload,
  expiresIn = '15m',
): Promise<string> {
  return signAccessToken(payload, privateKey, expiresIn)
}

async function buildTestApp(redisOverride?: FakeRedis) {
  const redis = redisOverride ?? new FakeRedis()
  const config = testConfig()
  const app = await buildApp({
    appConfig: config,
    databaseClients: createDatabaseClientsStub(),
    redis: redis as any,
    queues: createQueueRegistryStub(),
    healthChecks: {
      database: (): Promise<void> => Promise.resolve(),
      redis: (): Promise<void> => Promise.resolve(),
    },
  })

  return { app, redis }
}

// ──────────────────────────────────────────────────────────────────
// authenticate middleware tests
// ──────────────────────────────────────────────────────────────────

describe('authenticate middleware', () => {
  it('returns 401 when no Authorization header is provided', async () => {
    const { app } = await buildTestApp()

    // Register a protected route
    app.get('/test/protected', {
      preHandler: [(req: FastifyRequest, _reply: FastifyReply) => {
        if (req.user === undefined) {
          throw unauthenticated()
        }
      }],
    }, (req: FastifyRequest) => ({ userId: req.user?.sub }))

    const response = await app.inject({ method: 'GET', url: '/test/protected' })
    expect(response.statusCode).toBe(401)
    await app.close()
  })

  it('populates request.user on valid JWT', async () => {
    const { app } = await buildTestApp()
    const token = await createToken(basePayload())

    app.get('/test/whoami', (req: FastifyRequest) => ({
      success: true,
      data: { sub: req.user?.sub, email: req.user?.email, role: req.user?.role },
      requestId: req.requestId,
    }))

    const response = await app.inject({
      method: 'GET',
      url: '/test/whoami',
      headers: { authorization: `Bearer ${token}` },
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.data.sub).toBe('00000000-0000-0000-0000-000000000001')
    expect(body.data.email).toBe('test@fintrack.ng')
    expect(body.data.role).toBe('user')
    await app.close()
  })

  it('returns 401 on malformed JWT', async () => {
    const { app } = await buildTestApp()

    app.get('/test/protected', {
      preHandler: [(req: FastifyRequest, _reply: FastifyReply) => {
        if (req.user === undefined) {
          throw unauthenticated()
        }
      }],
    }, (req: FastifyRequest) => ({ userId: req.user?.sub }))

    const response = await app.inject({
      method: 'GET',
      url: '/test/protected',
      headers: { authorization: 'Bearer not.a.valid.jwt' },
    })

    expect(response.statusCode).toBe(401)
    const body = response.json()
    expect(body.error.code).toBe(ERROR_CODES.UNAUTHENTICATED)
    await app.close()
  })

  it('returns 401 on expired JWT', async () => {
    const { app } = await buildTestApp()

    // Sign a token that expires immediately (0s)
    const token = await createToken(basePayload(), '0s')

    app.get('/test/protected', {
      preHandler: [(req: FastifyRequest, _reply: FastifyReply) => {
        if (req.user === undefined) {
          throw unauthenticated()
        }
      }],
    }, (req: FastifyRequest) => ({ userId: req.user?.sub }))

    // Small delay to ensure token is expired
    await new Promise((resolve) => setTimeout(resolve, 50))

    const response = await app.inject({
      method: 'GET',
      url: '/test/protected',
      headers: { authorization: `Bearer ${token}` },
    })

    expect(response.statusCode).toBe(401)
    await app.close()
  })
})

// ──────────────────────────────────────────────────────────────────
// authorize middleware tests (RBAC)
// ──────────────────────────────────────────────────────────────────

describe('authorize middleware (RBAC)', () => {
  it('allows user to access own-scoped resource', async () => {
    const { app } = await buildTestApp()
    const { authorize } = await import('../src/core/middleware/authorize')
    const { authenticate } = await import('../src/core/middleware/authenticate')

    const token = await createToken(basePayload({ role: 'user' }))

    app.get('/test/my-txns', {
      preHandler: [authenticate, authorize('transactions:own:read')],
    }, () => ({ data: 'transactions' }))

    const response = await app.inject({
      method: 'GET',
      url: '/test/my-txns',
      headers: { authorization: `Bearer ${token}` },
    })

    expect(response.statusCode).toBe(200)
    await app.close()
  })

  it('blocks user from any-scoped resource', async () => {
    const { app } = await buildTestApp()
    const { authorize } = await import('../src/core/middleware/authorize')
    const { authenticate } = await import('../src/core/middleware/authenticate')

    const token = await createToken(basePayload({ role: 'user' }))

    app.get('/test/all-users', {
      preHandler: [authenticate, authorize('users:any:read')],
    }, () => ({ data: 'all users' }))

    const response = await app.inject({
      method: 'GET',
      url: '/test/all-users',
      headers: { authorization: `Bearer ${token}` },
    })

    expect(response.statusCode).toBe(403)
    expect(response.json().error.code).toBe(ERROR_CODES.FORBIDDEN)
    await app.close()
  })

  it('allows support to read any-scoped transactions', async () => {
    const { app } = await buildTestApp()
    const { authorize } = await import('../src/core/middleware/authorize')
    const { authenticate } = await import('../src/core/middleware/authenticate')

    const token = await createToken(basePayload({ role: 'support' }))

    app.get('/test/all-txns', {
      preHandler: [authenticate, authorize('transactions:any:read')],
    }, () => ({ data: 'all transactions' }))

    const response = await app.inject({
      method: 'GET',
      url: '/test/all-txns',
      headers: { authorization: `Bearer ${token}` },
    })

    expect(response.statusCode).toBe(200)
    await app.close()
  })

  it('allows admin to bypass all permission checks', async () => {
    const { app } = await buildTestApp()
    const { authorize } = await import('../src/core/middleware/authorize')
    const { authenticate } = await import('../src/core/middleware/authenticate')

    const token = await createToken(basePayload({ role: 'admin' }))

    app.delete('/test/nuke', {
      preHandler: [authenticate, authorize('dangerous:any:delete')],
    }, () => ({ data: 'nuked' }))

    const response = await app.inject({
      method: 'DELETE',
      url: '/test/nuke',
      headers: { authorization: `Bearer ${token}` },
    })

    expect(response.statusCode).toBe(200)
    await app.close()
  })

  it('returns 401 when authorize is called without authentication', async () => {
    const { app } = await buildTestApp()
    const { authorize } = await import('../src/core/middleware/authorize')

    app.get('/test/no-auth', {
      preHandler: [authorize('transactions:own:read')],
    }, () => ({ data: 'should not reach here' }))

    const response = await app.inject({ method: 'GET', url: '/test/no-auth' })
    expect(response.statusCode).toBe(401)
    await app.close()
  })
})

// ──────────────────────────────────────────────────────────────────
// ownership middleware tests
// ──────────────────────────────────────────────────────────────────

describe('ownership middleware', () => {
  it('allows access when resource belongs to authenticated user', async () => {
    const { app } = await buildTestApp()
    const { ownership } = await import('../src/core/middleware/ownership')
    const { authenticate } = await import('../src/core/middleware/authenticate')

    const userId = '00000000-0000-0000-0000-000000000001'
    const token = await createToken(basePayload({ sub: userId }))

    const loader = async (_id: string) => ({ userId })

    app.get('/test/accounts/:id', {
      preHandler: [authenticate, ownership('id', loader)],
    }, () => ({ data: 'my account' }))

    const response = await app.inject({
      method: 'GET',
      url: '/test/accounts/some-uuid',
      headers: { authorization: `Bearer ${token}` },
    })

    expect(response.statusCode).toBe(200)
    await app.close()
  })

  it('returns 404 — NOT 403 — when resource belongs to another user', async () => {
    const { app } = await buildTestApp()
    const { ownership } = await import('../src/core/middleware/ownership')
    const { authenticate } = await import('../src/core/middleware/authenticate')

    const token = await createToken(basePayload({ sub: '00000000-0000-0000-0000-000000000001' }))

    // Resource belongs to a different user
    const loader = async (_id: string) => ({ userId: '00000000-0000-0000-0000-000000000099' })

    app.get('/test/accounts/:id', {
      preHandler: [authenticate, ownership('id', loader)],
    }, () => ({ data: 'should not reach' }))

    const response = await app.inject({
      method: 'GET',
      url: '/test/accounts/some-uuid',
      headers: { authorization: `Bearer ${token}` },
    })

    // Architecture mandate: 404 not 403 — don't confirm resource existence
    expect(response.statusCode).toBe(404)
    expect(response.json().error.code).toBe(ERROR_CODES.NOT_FOUND)
    await app.close()
  })

  it('returns 404 when resource does not exist', async () => {
    const { app } = await buildTestApp()
    const { ownership } = await import('../src/core/middleware/ownership')
    const { authenticate } = await import('../src/core/middleware/authenticate')

    const token = await createToken(basePayload())

    const loader = async (_id: string) => null

    app.get('/test/accounts/:id', {
      preHandler: [authenticate, ownership('id', loader)],
    }, () => ({ data: 'should not reach' }))

    const response = await app.inject({
      method: 'GET',
      url: '/test/accounts/nonexistent-uuid',
      headers: { authorization: `Bearer ${token}` },
    })

    expect(response.statusCode).toBe(404)
    await app.close()
  })
})

// ──────────────────────────────────────────────────────────────────
// requireSubscription middleware tests
// ──────────────────────────────────────────────────────────────────

describe('requireSubscription middleware', () => {
  it('allows PRO user with valid subscription expiry', async () => {
    const { app } = await buildTestApp()
    const { requireSubscription } = await import('../src/core/middleware/require-subscription')
    const { authenticate } = await import('../src/core/middleware/authenticate')

    const futureDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
    const token = await createToken(basePayload({
      tier: 'PRO',
      subscriptionExpiresAt: futureDate,
    }))

    app.get('/test/pro-feature', {
      preHandler: [authenticate, requireSubscription],
    }, () => ({ data: 'pro content' }))

    const response = await app.inject({
      method: 'GET',
      url: '/test/pro-feature',
      headers: { authorization: `Bearer ${token}` },
    })

    expect(response.statusCode).toBe(200)
    await app.close()
  })

  it('returns 402 for FREE user', async () => {
    const { app } = await buildTestApp()
    const { requireSubscription } = await import('../src/core/middleware/require-subscription')
    const { authenticate } = await import('../src/core/middleware/authenticate')

    const token = await createToken(basePayload({ tier: 'FREE' }))

    app.get('/test/pro-feature', {
      preHandler: [authenticate, requireSubscription],
    }, () => ({ data: 'pro content' }))

    const response = await app.inject({
      method: 'GET',
      url: '/test/pro-feature',
      headers: { authorization: `Bearer ${token}` },
    })

    expect(response.statusCode).toBe(402)
    expect(response.json().error.code).toBe(ERROR_CODES.SUBSCRIPTION_REQUIRED)
    await app.close()
  })

  it('falls back to DB when tier-change signal exists in Redis', async () => {
    const fakeRedis = new FakeRedis()
    const userId = '00000000-0000-0000-0000-000000000001'

    // Set the tier-change signal in Redis
    await fakeRedis.set(`tier-change:${userId}`, '1')

    const { app } = await buildTestApp(fakeRedis)
    const { requireSubscription } = await import('../src/core/middleware/require-subscription')
    const { authenticate } = await import('../src/core/middleware/authenticate')

    // JWT says PRO but tier-change signal is pending
    const token = await createToken(basePayload({ sub: userId, tier: 'PRO' }))

    app.get('/test/pro-feature', {
      preHandler: [authenticate, requireSubscription],
    }, () => ({ data: 'pro content' }))

    const response = await app.inject({
      method: 'GET',
      url: '/test/pro-feature',
      headers: { authorization: `Bearer ${token}` },
    })

    // DB stub returns null subscription → 402
    expect(response.statusCode).toBe(402)
    await app.close()
  })

  it('returns 401 when no user is authenticated', async () => {
    const { app } = await buildTestApp()
    const { requireSubscription } = await import('../src/core/middleware/require-subscription')

    app.get('/test/pro-feature', {
      preHandler: [requireSubscription],
    }, () => ({ data: 'pro content' }))

    const response = await app.inject({ method: 'GET', url: '/test/pro-feature' })
    expect(response.statusCode).toBe(401)
    await app.close()
  })
})
