import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { buildApp } from '../../../src/app'
import { generateKeyPairSync } from 'node:crypto'
import {
  createDatabaseClientsStub,
  createQueueRegistryStub,
  FakeRedis,
} from '../../helpers/fakes'
import { loadConfig } from '../../../src/config'
import type { PrismaClient } from '../../../src/generated/prisma/client'
import { hashPassword } from '../../../src/core/crypto/hashing'
import { ERROR_CODES } from '../../../src/core/errors/codes'
import { randomUUID } from 'node:crypto'

// ──────────────────────────────────────────────────────────────────
// Test infrastructure
// ──────────────────────────────────────────────────────────────────

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})

// In-memory user store for the stubbed Prisma
const users = new Map<string, { id: string; email: string; passwordHash: string; tier: string; createdAt: Date }>()

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
    user: {
      create: ({ data }: { data: { email: string; passwordHash: string } }): Promise<unknown> => {
        // Check unique constraint
        for (const user of users.values()) {
          if (user.email === data.email) {
            const error = Object.assign(new Error('Unique constraint'), { code: 'P2002' })
            return Promise.reject(error)
          }
        }
        const id = randomUUID()
        const record = { id, email: data.email, passwordHash: data.passwordHash, tier: 'FREE', createdAt: new Date() }
        users.set(id, record)
        return Promise.resolve(record)
      },
      findUnique: ({ where }: { where: { email?: string; id?: string } }): Promise<unknown> => {
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
        return Promise.resolve(null)
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
    FIELD_ENCRYPTION_KEY_BASE64: Buffer.alloc(32).toString('base64'),
    JWT_PUBLIC_KEY_PEM: publicKey,
    JWT_PRIVATE_KEY_PEM: privateKey,
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
