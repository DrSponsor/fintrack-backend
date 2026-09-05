import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest'
import { buildApp } from '../../../src/app'
import { generateKeyPairSync } from 'node:crypto'
import {
  createQueueRegistryStub,
  FakeRedis,
} from '../../helpers/fakes'
import { loadConfig } from '../../../src/config'
import type { PrismaClient } from '../../../src/generated/prisma/client'
import { hashPassword } from '../../../src/core/crypto/hashing'
import { ERROR_CODES } from '../../../src/core/errors/codes'
import { randomUUID } from 'node:crypto'
import { signAccessToken } from '../../../src/core/crypto/tokens'

// ──────────────────────────────────────────────────────────────────
// Test infrastructure
// ──────────────────────────────────────────────────────────────────

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})

// In-memory user store for the stubbed Prisma
const users = new Map<string, { id: string; email: string; passwordHash: string | null; googleId: string | null; tier: string; createdAt: Date }>()

function createAuthPrismaStub(): PrismaClient {
  const client = {
    $queryRaw: (): Promise<readonly { readonly ok: number }[]> => Promise.resolve([{ ok: 1 }]),
    $disconnect: (): Promise<void> => Promise.resolve(),
    auditLog: {
      create: (): Promise<unknown> => Promise.resolve({ id: 'audit' }),
    },
    subscription: {
      findUnique: (): Promise<unknown> => Promise.resolve(null),
    },
    category: {
      findMany: (): Promise<readonly { readonly id: string; readonly name: string }[]> =>
        Promise.resolve([{ id: 'uncategorised-id', name: 'uncategorised' }]),
      findUnique: (): Promise<unknown> =>
        Promise.resolve({ id: 'uncategorised-id', name: 'uncategorised', icon: 'circle-help' }),
    },
    user: {
      create: ({ data }: { data: { email: string; passwordHash?: string | null; googleId?: string | null } }): Promise<unknown> => {
        // Check unique constraint
        for (const user of users.values()) {
          if (user.email === data.email) {
            const error = Object.assign(new Error('Unique constraint'), { code: 'P2002' })
            return Promise.reject(error)
          }
          if (data.googleId && user.googleId === data.googleId) {
            const error = Object.assign(new Error('Unique constraint'), { code: 'P2002' })
            return Promise.reject(error)
          }
        }
        const id = randomUUID()
        const record = {
          id,
          email: data.email,
          passwordHash: data.passwordHash ?? null,
          googleId: data.googleId ?? null,
          tier: 'FREE',
          createdAt: new Date(),
        }
        users.set(id, record)
        return Promise.resolve(record)
      },
      findUnique: ({ where }: { where: { email?: string; id?: string; googleId?: string } }): Promise<unknown> => {
        if (where.email !== undefined) {
          for (const user of users.values()) {
            if (user.email === where.email) {
              return Promise.resolve(user)
            }
          }
        }
        if (where.id !== undefined) {
          const user = users.get(where.id)
          if (user !== undefined) {
            return Promise.resolve(user)
          }
        }
        if (where.googleId !== undefined) {
          for (const user of users.values()) {
            if (user.googleId === where.googleId) {
              return Promise.resolve(user)
            }
          }
        }
        return Promise.resolve(null)
      },
      update: ({ where, data }: { where: { id: string }; data: { googleId?: string | null; tier?: string } }): Promise<unknown> => {
        const user = users.get(where.id)
        if (user === undefined) {
          return Promise.reject(new Error('User not found'))
        }
        const updated = {
          ...user,
          ...(data.googleId !== undefined ? { googleId: data.googleId } : {}),
          ...(data.tier !== undefined ? { tier: data.tier } : {}),
        }
        users.set(where.id, updated)
        return Promise.resolve(updated)
      },
    },
  }

  return client as unknown as PrismaClient
}

let app: Awaited<ReturnType<typeof buildApp>>

// Set env vars for JWT keys before building the app
beforeAll(async () => {
  process.env['JWT_PUBLIC_KEY_PEM'] = publicKey
  process.env['JWT_PRIVATE_KEY_PEM'] = privateKey

  users.clear()

  const prisma = createAuthPrismaStub()
  const redis = new FakeRedis()
  const config = loadConfig({
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: '3000',
    LOG_LEVEL: 'silent',
    DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/fintrack?pgbouncer=true',
    DIRECT_URL: 'postgresql://postgres:postgres@localhost:5432/fintrack',
    REDIS_URL: 'redis://localhost:6379',
    FIELD_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 7).toString('base64'),
    JWT_PUBLIC_KEY_PEM: publicKey,
    JWT_PRIVATE_KEY_PEM: privateKey,
    GOOGLE_CLIENT_ID: 'google-client-id-test',
  })

  app = await buildApp({
    appConfig: config,
    databaseClients: { primary: prisma, read: prisma },
    redis: redis as any,
    queues: createQueueRegistryStub(),
    healthChecks: {
      database: (): Promise<void> => Promise.resolve(),
      redis: (): Promise<void> => Promise.resolve(),
    },
  })

  await app.ready()
})

afterAll(async () => {
  await app.close()
  delete process.env['JWT_PUBLIC_KEY_PEM']
  delete process.env['JWT_PRIVATE_KEY_PEM']
})

// ──────────────────────────────────────────────────────────────────
// Auth route integration tests
// ──────────────────────────────────────────────────────────────────

describe('POST /v1/auth/register', () => {
  it('registers a new user and returns accessToken', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        email: 'integration@fintrack.ng',
        password: 'SecureP@ss1',
      },
    })

    expect(response.statusCode).toBe(201)
    const body = response.json()
    expect(body.success).toBe(true)
    expect(body.data.userId).toBeTruthy()
    expect(body.data.accessToken).toBeTruthy()
    expect(body.data.expiresIn).toBe(900)
  })

  it('returns 409 for duplicate email', async () => {
    // First registration already done above
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        email: 'integration@fintrack.ng',
        password: 'SecureP@ss1',
      },
    })

    expect(response.statusCode).toBe(409)
    expect(response.json().error.code).toBe(ERROR_CODES.DUPLICATE_EMAIL)
  })

  it('returns 400 for invalid email', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        email: 'not-an-email',
        password: 'SecureP@ss1',
      },
    })

    expect(response.statusCode).toBe(400)
  })
})

describe('POST /v1/auth/login', () => {
  it('logs in with correct credentials', async () => {
    // Register first
    const hash = await hashPassword('LoginP@ss1')
    const userId = randomUUID()
    users.set(userId, {
      id: userId,
      email: 'login-test@fintrack.ng',
      passwordHash: hash,
      googleId: null,
      tier: 'FREE',
      createdAt: new Date(),
    })

    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: {
        email: 'login-test@fintrack.ng',
        password: 'LoginP@ss1',
      },
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.success).toBe(true)
    expect(body.data.accessToken).toBeTruthy()
    expect(body.data.expiresIn).toBe(900)
  })

  it('returns 401 for wrong password', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: {
        email: 'login-test@fintrack.ng',
        password: 'WrongP@ss1',
      },
    })

    expect(response.statusCode).toBe(401)
    expect(response.json().error.code).toBe(ERROR_CODES.INVALID_CREDENTIALS)
  })

  it('returns 401 for non-existent email (same error as wrong password)', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: {
        email: 'ghost@fintrack.ng',
        password: 'AnyP@ss123',
      },
    })

    expect(response.statusCode).toBe(401)
    expect(response.json().error.code).toBe(ERROR_CODES.INVALID_CREDENTIALS)
  })
})

describe('POST /v1/auth/logout', () => {
  it('returns 401 without authorization header', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
    })

    expect(response.statusCode).toBe(401)
  })
})

describe('POST /v1/auth/google', () => {
  it('registers/logs in user successfully with valid Google ID token', async () => {
    const spyFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        sub: 'google-sub-route-test-123',
        email: 'route-test@fintrack.ng',
        email_verified: true,
        aud: 'google-client-id-test',
      }),
    } as Response)

    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/google',
      payload: {
        idToken: 'valid-mock-token',
      },
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.success).toBe(true)
    expect(body.data.userId).toBeTruthy()
    expect(body.data.accessToken).toBeTruthy()
    // refreshToken must be present in the JSON body, not only the cookie —
    // native mobile clients (Axios/fetch) don't persist cookies across
    // requests by default, so the cookie alone leaves them unable to
    // refresh past the access token's 15-minute lifetime.
    expect(body.data.refreshToken).toBeTruthy()
    expect(body.data.expiresIn).toBe(900)

    const cookies = response.cookies
    const refreshCookie = cookies.find((c) => c.name === 'refreshToken')
    expect(refreshCookie).toBeTruthy()
    expect(refreshCookie?.httpOnly).toBe(true)
    expect(refreshCookie?.path).toBe('/v1/auth')
    expect(refreshCookie?.value).toBe(body.data.refreshToken)

    spyFetch.mockRestore()
  })

  it('returns 400 for missing idToken', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/google',
      payload: {},
    })

    expect(response.statusCode).toBe(400)
  })

  it('returns 401 for invalid/failed Google token verification', async () => {
    const spyFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      text: () => Promise.resolve('Token expired'),
    } as Response)

    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/google',
      payload: {
        idToken: 'expired-token',
      },
    })

    expect(response.statusCode).toBe(401)
    expect(response.json().error.code).toBe(ERROR_CODES.UNAUTHENTICATED)

    spyFetch.mockRestore()
  })
})

// ──────────────────────────────────────────────────────────────────
// POST /v1/auth/refresh
//
// This endpoint had no test at all, and shipped broken because of it.
//
// It was mounted behind `authenticate`, so it demanded a valid access token —
// while being the endpoint whose entire purpose is to replace an access token
// that is no longer valid. Every session therefore ended fifteen minutes after
// sign-in: the client 401'd, tried to refresh, was 401'd again for holding the
// very token it was trying to replace, and logged the user out.
//
// Nothing above catches that, because every other test signs in and uses the
// token immediately, which is the one condition under which the bug is
// invisible. These tests exist to make the passage of time explicit.
// ──────────────────────────────────────────────────────────────────
describe('POST /v1/auth/refresh', () => {
  async function signUp(email: string): Promise<{ accessToken: string; refreshToken: string }> {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email, password: 'SecureP@ss1' },
    })
    expect(response.statusCode).toBe(201)
    const body = response.json()
    return { accessToken: body.data.accessToken, refreshToken: body.data.refreshToken }
  }

  it('refreshes with no Authorization header at all', async () => {
    const { refreshToken } = await signUp('refresh-plain@fintrack.ng')

    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken },
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.data.accessToken).toBeTruthy()
    expect(body.data.expiresIn).toBe(900)
    // Rotating: the token that comes back must not be the one sent.
    expect(body.data.refreshToken).not.toBe(refreshToken)
  })

  it('refreshes while holding an EXPIRED access token', async () => {
    // The regression. A real client attaches its access token to every
    // request, including this one — so the expired token travels with the
    // refresh attempt. If the server rejects the request on account of it,
    // the session can never be renewed and the user is signed out.
    const { refreshToken } = await signUp('refresh-expired@fintrack.ng')

    const expiredAccessToken = await signAccessToken(
      {
        sub: randomUUID(),
        email: 'refresh-expired@fintrack.ng',
        role: 'user',
        tier: 'FREE',
        sid: randomUUID(),
      },
      privateKey,
      '-10 seconds',
    )

    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: { authorization: `Bearer ${expiredAccessToken}` },
      payload: { refreshToken },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().data.accessToken).toBeTruthy()
  })

  it('issues a token that still works after a further refresh', async () => {
    // One rotation working proves little; a session lasts for many. This
    // catches a rotation that returns a token it cannot itself consume.
    const { refreshToken } = await signUp('refresh-chain@fintrack.ng')

    const first = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken },
    })
    expect(first.statusCode).toBe(200)

    const second = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: first.json().data.refreshToken },
    })
    expect(second.statusCode).toBe(200)
    expect(second.json().data.refreshToken).not.toBe(first.json().data.refreshToken)
  })

  it('rejects a refresh token that was already spent', async () => {
    // Rotation is one-time use, and replaying a consumed token is the
    // signature of a stolen one. Dropping `authenticate` from this route made
    // the refresh token the sole credential, so this defence is now the whole
    // of the endpoint's security and must be asserted, not assumed.
    const { refreshToken } = await signUp('refresh-replay@fintrack.ng')

    const first = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken },
    })
    expect(first.statusCode).toBe(200)

    const replay = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken },
    })
    expect(replay.statusCode).toBe(401)
  })

  it('rejects a token belonging to no session', async () => {
    // Well-formed and correctly shaped, but never minted here. Parsing must
    // not be mistaken for authenticating.
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: `${randomUUID()}.${randomUUID()}.${'a'.repeat(64)}` },
    })

    expect(response.statusCode).toBe(401)
  })

  it('rejects a malformed refresh token', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: 'not-a-refresh-token' },
    })

    expect(response.statusCode).toBe(401)
  })

  it('rejects a request with no refresh token', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: {},
    })

    expect(response.statusCode).toBe(401)
  })
})
