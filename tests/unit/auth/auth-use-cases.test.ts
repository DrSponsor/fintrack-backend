import { describe, expect, it, vi, beforeEach } from 'vitest'
import { RegisterUseCase } from '../../../src/modules/auth/use-cases/register.use-case'
import { LoginUseCase } from '../../../src/modules/auth/use-cases/login.use-case'
import { RefreshUseCase } from '../../../src/modules/auth/use-cases/refresh.use-case'
import { LogoutUseCase } from '../../../src/modules/auth/use-cases/logout.use-case'
import type { IUserRepository, UserRecord } from '../../../src/modules/auth/repositories/user.repo'
import type { ISessionRepository, CreateSessionResult } from '../../../src/modules/auth/repositories/session.repo'
import { hashPassword } from '../../../src/core/crypto/hashing'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { AppError } from '../../../src/core/errors/AppError'
import { ERROR_CODES } from '../../../src/core/errors/codes'

// ──────────────────────────────────────────────────────────────────
// Shared test infrastructure
// ──────────────────────────────────────────────────────────────────

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})

const silentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
  trace: vi.fn(),
  child: () => silentLogger,
} as any

function makeUserRecord(overrides: Partial<UserRecord> = {}): UserRecord {
  return {
    id: randomUUID(),
    email: 'test@fintrack.ng',
    passwordHash: 'hash',
    tier: 'FREE',
    role: 'user',
    createdAt: new Date(),
    ...overrides,
  }
}

function makeFakeSession(): CreateSessionResult {
  return {
    sessionId: randomUUID(),
    refreshToken: 'fake-refresh-token-hex',
  }
}

function createMockUserRepo(overrides: Partial<IUserRepository> = {}): IUserRepository {
  return {
    create: vi.fn().mockResolvedValue(makeUserRecord()),
    findByEmail: vi.fn().mockResolvedValue(null),
    findById: vi.fn().mockResolvedValue(null),
    updateTier: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

function createMockSessionRepo(overrides: Partial<ISessionRepository> = {}): ISessionRepository {
  return {
    create: vi.fn().mockResolvedValue(makeFakeSession()),
    consume: vi.fn().mockResolvedValue(null),
    rotate: vi.fn().mockResolvedValue(null),
    revoke: vi.fn().mockResolvedValue(undefined),
    revokeAll: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

// ──────────────────────────────────────────────────────────────────
// RegisterUseCase
// ──────────────────────────────────────────────────────────────────

describe('RegisterUseCase', () => {
  it('registers a user and returns token pair', async () => {
    const userId = randomUUID()
    const sessionId = randomUUID()
    const userRepo = createMockUserRepo({
      create: vi.fn().mockResolvedValue(makeUserRecord({ id: userId, email: 'new@fintrack.ng' })),
    })
    const sessionRepo = createMockSessionRepo({
      create: vi.fn().mockResolvedValue({ sessionId, refreshToken: 'rt-123' }),
    })

    const useCase = new RegisterUseCase({
      userRepo,
      sessionRepo,
      jwtPrivateKeyPem: privateKey,
      logger: silentLogger,
    })

    const result = await useCase.execute({
      email: 'New@FinTrack.ng',
      password: 'SecureP@ss1',
    })

    expect(result.userId).toBe(userId)
    expect(result.accessToken).toBeTruthy()
    expect(result.refreshToken).toBe('rt-123')
    expect(result.sessionId).toBe(sessionId)
    expect(result.expiresIn).toBe(900)
    expect(userRepo.create).toHaveBeenCalledOnce()
    expect(sessionRepo.create).toHaveBeenCalledWith(userId)
  })

  it('rejects weak passwords', async () => {
    const useCase = new RegisterUseCase({
      userRepo: createMockUserRepo(),
      sessionRepo: createMockSessionRepo(),
      jwtPrivateKeyPem: privateKey,
      logger: silentLogger,
    })

    await expect(useCase.execute({
      email: 'test@fintrack.ng',
      password: 'weak',
    })).rejects.toThrow(AppError)
  })

  it('throws DUPLICATE_EMAIL on unique constraint violation', async () => {
    const error = Object.assign(new Error('unique'), { code: 'P2002' })
    const userRepo = createMockUserRepo({
      create: vi.fn().mockRejectedValue(error),
    })

    const useCase = new RegisterUseCase({
      userRepo,
      sessionRepo: createMockSessionRepo(),
      jwtPrivateKeyPem: privateKey,
      logger: silentLogger,
    })

    try {
      await useCase.execute({
        email: 'dup@fintrack.ng',
        password: 'SecureP@ss1',
      })
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(AppError)
      expect((err as AppError).code).toBe(ERROR_CODES.DUPLICATE_EMAIL)
      expect((err as AppError).statusCode).toBe(409)
    }
  })

  it('re-throws non-unique-constraint DB errors', async () => {
    const dbError = new Error('connection lost')
    const userRepo = createMockUserRepo({
      create: vi.fn().mockRejectedValue(dbError),
    })

    const useCase = new RegisterUseCase({
      userRepo,
      sessionRepo: createMockSessionRepo(),
      jwtPrivateKeyPem: privateKey,
      logger: silentLogger,
    })

    await expect(useCase.execute({
      email: 'test@fintrack.ng',
      password: 'SecureP@ss1',
    })).rejects.toThrow('connection lost')
  })
})

// ──────────────────────────────────────────────────────────────────
// LoginUseCase
// ──────────────────────────────────────────────────────────────────

describe('LoginUseCase', () => {
  let validPasswordHash: string

  beforeEach(async () => {
    validPasswordHash = await hashPassword('SecureP@ss1')
  })

  it('authenticates with correct credentials', async () => {
    const userId = randomUUID()
    const userRepo = createMockUserRepo({
      findByEmail: vi.fn().mockResolvedValue(
        makeUserRecord({ id: userId, passwordHash: validPasswordHash }),
      ),
    })

    const useCase = new LoginUseCase({
      userRepo,
      sessionRepo: createMockSessionRepo(),
      jwtPrivateKeyPem: privateKey,
      logger: silentLogger,
    })

    const result = await useCase.execute({
      email: 'test@fintrack.ng',
      password: 'SecureP@ss1',
    })

    expect(result.accessToken).toBeTruthy()
    expect(result.refreshToken).toBeTruthy()
    expect(result.expiresIn).toBe(900)
  })

  it('returns INVALID_CREDENTIALS for non-existent email', async () => {
    const userRepo = createMockUserRepo({
      findByEmail: vi.fn().mockResolvedValue(null),
    })

    const useCase = new LoginUseCase({
      userRepo,
      sessionRepo: createMockSessionRepo(),
      jwtPrivateKeyPem: privateKey,
      logger: silentLogger,
    })

    try {
      await useCase.execute({
        email: 'nobody@fintrack.ng',
        password: 'SecureP@ss1',
      })
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(AppError)
      expect((err as AppError).code).toBe(ERROR_CODES.INVALID_CREDENTIALS)
    }
  })

  it('returns same error for wrong password as for non-existent email', async () => {
    const userRepo = createMockUserRepo({
      findByEmail: vi.fn().mockResolvedValue(
        makeUserRecord({ passwordHash: validPasswordHash }),
      ),
    })

    const useCase = new LoginUseCase({
      userRepo,
      sessionRepo: createMockSessionRepo(),
      jwtPrivateKeyPem: privateKey,
      logger: silentLogger,
    })

    try {
      await useCase.execute({
        email: 'test@fintrack.ng',
        password: 'WrongP@ss1',
      })
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(AppError)
      // Same error code as non-existent email — prevents enumeration
      expect((err as AppError).code).toBe(ERROR_CODES.INVALID_CREDENTIALS)
    }
  })
})

// ──────────────────────────────────────────────────────────────────
// RefreshUseCase
// ──────────────────────────────────────────────────────────────────

describe('RefreshUseCase', () => {
  it('rotates token and returns new pair', async () => {
    const userId = randomUUID()
    const oldSessionId = randomUUID()
    const newSessionId = randomUUID()

    const sessionRepo = createMockSessionRepo({
      rotate: vi.fn().mockResolvedValue({ sessionId: newSessionId, refreshToken: 'new-rt' }),
    })
    const userRepo = createMockUserRepo({
      findById: vi.fn().mockResolvedValue(makeUserRecord({ id: userId })),
    })

    const useCase = new RefreshUseCase({
      userRepo,
      sessionRepo,
      jwtPrivateKeyPem: privateKey,
      logger: silentLogger,
    })

    const result = await useCase.execute(userId, oldSessionId, 'old-rt')

    expect(result.accessToken).toBeTruthy()
    expect(result.refreshToken).toBe('new-rt')
    expect(result.sessionId).toBe(newSessionId)
    expect(sessionRepo.rotate).toHaveBeenCalledWith(userId, oldSessionId, 'old-rt')
  })

  it('throws TOKEN_REVOKED when rotation fails (reuse detected)', async () => {
    const sessionRepo = createMockSessionRepo({
      rotate: vi.fn().mockResolvedValue(null),
    })

    const useCase = new RefreshUseCase({
      userRepo: createMockUserRepo(),
      sessionRepo,
      jwtPrivateKeyPem: privateKey,
      logger: silentLogger,
    })

    try {
      await useCase.execute(randomUUID(), randomUUID(), 'stolen-rt')
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(AppError)
      expect((err as AppError).code).toBe(ERROR_CODES.TOKEN_REVOKED)
    }
  })

  it('throws UNAUTHENTICATED when user no longer exists', async () => {
    const sessionRepo = createMockSessionRepo({
      rotate: vi.fn().mockResolvedValue(makeFakeSession()),
    })
    const userRepo = createMockUserRepo({
      findById: vi.fn().mockResolvedValue(null),
    })

    const useCase = new RefreshUseCase({
      userRepo,
      sessionRepo,
      jwtPrivateKeyPem: privateKey,
      logger: silentLogger,
    })

    try {
      await useCase.execute(randomUUID(), randomUUID(), 'rt')
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(AppError)
      expect((err as AppError).code).toBe(ERROR_CODES.UNAUTHENTICATED)
    }
  })
})

// ──────────────────────────────────────────────────────────────────
// LogoutUseCase
// ──────────────────────────────────────────────────────────────────

describe('LogoutUseCase', () => {
  it('revokes the session', async () => {
    const userId = randomUUID()
    const sessionId = randomUUID()
    const sessionRepo = createMockSessionRepo()

    const useCase = new LogoutUseCase({
      sessionRepo,
      logger: silentLogger,
    })

    await useCase.execute(userId, sessionId)

    expect(sessionRepo.revoke).toHaveBeenCalledWith(userId, sessionId)
  })
})
