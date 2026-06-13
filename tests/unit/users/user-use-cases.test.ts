import { describe, expect, it, vi } from 'vitest'
import { GetProfileUseCase } from '../../../src/modules/users/use-cases/get-profile.use-case'
import { UpdateProfileUseCase } from '../../../src/modules/users/use-cases/update-profile.use-case'
import { DeleteDataUseCase } from '../../../src/modules/users/use-cases/delete-data.use-case'
import type { IUserProfileRepository, UserProfile } from '../../../src/modules/users/repositories/user-profile.repo'
import type { ISessionRepository } from '../../../src/modules/auth/repositories/session.repo'
import { AppError } from '../../../src/core/errors/AppError'
import { ERROR_CODES } from '../../../src/core/errors/codes'
import { randomUUID } from 'node:crypto'

// ──────────────────────────────────────────────────────────────────
// Shared test infrastructure
// ──────────────────────────────────────────────────────────────────

const silentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
  trace: vi.fn(),
  child: () => silentLogger,
} as any

function makeProfile(overrides: Partial<UserProfile> = {}): UserProfile {
  return {
    id: randomUUID(),
    email: 'test@fintrack.ng',
    phone: null,
    tier: 'FREE',
    accountCount: 0,
    createdAt: new Date(),
    ...overrides,
  }
}

function createMockProfileRepo(overrides: Partial<IUserProfileRepository> = {}): IUserProfileRepository {
  return {
    findById: vi.fn().mockResolvedValue(makeProfile()),
    update: vi.fn().mockResolvedValue(makeProfile()),
    deleteAllData: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

function createMockSessionRepo(): ISessionRepository {
  return {
    create: vi.fn().mockResolvedValue({ sessionId: randomUUID(), refreshToken: 'rt' }),
    consume: vi.fn().mockResolvedValue(null),
    rotate: vi.fn().mockResolvedValue(null),
    revoke: vi.fn().mockResolvedValue(undefined),
    revokeAll: vi.fn().mockResolvedValue(undefined),
  }
}

// ──────────────────────────────────────────────────────────────────
// GetProfileUseCase
// ──────────────────────────────────────────────────────────────────

describe('GetProfileUseCase', () => {
  it('returns profile for existing user', async () => {
    const userId = randomUUID()
    const profile = makeProfile({ id: userId })
    const profileRepo = createMockProfileRepo({
      findById: vi.fn().mockResolvedValue(profile),
    })

    const useCase = new GetProfileUseCase({ userProfileRepo: profileRepo, logger: silentLogger })
    const result = await useCase.execute(userId)

    expect(result.id).toBe(userId)
    expect(result.email).toBe('test@fintrack.ng')
  })

  it('throws NOT_FOUND for deleted user', async () => {
    const profileRepo = createMockProfileRepo({
      findById: vi.fn().mockResolvedValue(null),
    })

    const useCase = new GetProfileUseCase({ userProfileRepo: profileRepo, logger: silentLogger })

    try {
      await useCase.execute('deleted-user-id')
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(AppError)
      expect((err as AppError).code).toBe(ERROR_CODES.NOT_FOUND)
    }
  })
})

// ──────────────────────────────────────────────────────────────────
// UpdateProfileUseCase
// ──────────────────────────────────────────────────────────────────

describe('UpdateProfileUseCase', () => {
  it('updates phone with valid Nigerian format', async () => {
    const userId = randomUUID()
    const updated = makeProfile({ id: userId, phone: '+2348012345678' })
    const profileRepo = createMockProfileRepo({
      update: vi.fn().mockResolvedValue(updated),
    })

    const useCase = new UpdateProfileUseCase({ userProfileRepo: profileRepo, logger: silentLogger })
    const result = await useCase.execute(userId, { phone: '+2348012345678' })

    expect(result.phone).toBe('+2348012345678')
  })

  it('rejects invalid Nigerian phone format', async () => {
    const useCase = new UpdateProfileUseCase({
      userProfileRepo: createMockProfileRepo(),
      logger: silentLogger,
    })

    await expect(useCase.execute('user-1', { phone: '08012345678' }))
      .rejects
      .toThrow(AppError)
  })

  it('rejects unknown properties (strict schema)', async () => {
    const useCase = new UpdateProfileUseCase({
      userProfileRepo: createMockProfileRepo(),
      logger: silentLogger,
    })

    await expect(useCase.execute('user-1', { phone: '+2348012345678', role: 'admin' }))
      .rejects
      .toThrow(AppError)
  })
})

// ──────────────────────────────────────────────────────────────────
// DeleteDataUseCase
// ──────────────────────────────────────────────────────────────────

describe('DeleteDataUseCase', () => {
  it('schedules deletion with 24h cooling-off', async () => {
    const fakeRedis = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue('OK'),
      del: vi.fn().mockResolvedValue(1),
    }

    const useCase = new DeleteDataUseCase({
      userProfileRepo: createMockProfileRepo(),
      sessionRepo: createMockSessionRepo(),
      redis: fakeRedis as any,
      logger: silentLogger,
    })

    const result = await useCase.execute('user-1')

    expect(result.message).toContain('24 hours')
    expect(result.scheduledDeletionAt).toBeTruthy()
    // Verify Redis SET was called with 24h TTL (86400 seconds)
    expect(fakeRedis.set).toHaveBeenCalledWith(
      expect.stringContaining('deletion-schedule:'),
      expect.any(String),
      'EX',
      86400,
    )
  })

  it('rejects duplicate deletion request (idempotent)', async () => {
    const fakeRedis = {
      get: vi.fn().mockResolvedValue('{"userId":"user-1"}'),
    }

    const useCase = new DeleteDataUseCase({
      userProfileRepo: createMockProfileRepo(),
      sessionRepo: createMockSessionRepo(),
      redis: fakeRedis as any,
      logger: silentLogger,
    })

    try {
      await useCase.execute('user-1')
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(AppError)
      expect((err as AppError).code).toBe(ERROR_CODES.CONFLICT)
    }
  })

  it('cancel removes the scheduled deletion', async () => {
    const fakeRedis = {
      del: vi.fn().mockResolvedValue(1),
    }

    const useCase = new DeleteDataUseCase({
      userProfileRepo: createMockProfileRepo(),
      sessionRepo: createMockSessionRepo(),
      redis: fakeRedis as any,
      logger: silentLogger,
    })

    await useCase.cancel('user-1')
    expect(fakeRedis.del).toHaveBeenCalledWith('deletion-schedule:user-1')
  })

  it('cancel throws NOT_FOUND if no deletion is pending', async () => {
    const fakeRedis = {
      del: vi.fn().mockResolvedValue(0),
    }

    const useCase = new DeleteDataUseCase({
      userProfileRepo: createMockProfileRepo(),
      sessionRepo: createMockSessionRepo(),
      redis: fakeRedis as any,
      logger: silentLogger,
    })

    await expect(useCase.cancel('user-1'))
      .rejects
      .toThrow(AppError)
  })

  it('immediate deletion revokes sessions then deletes data', async () => {
    const sessionRepo = createMockSessionRepo()
    const profileRepo = createMockProfileRepo()
    const fakeRedis = { del: vi.fn().mockResolvedValue(1) }

    const useCase = new DeleteDataUseCase({
      userProfileRepo: profileRepo,
      sessionRepo,
      redis: fakeRedis as any,
      logger: silentLogger,
    })

    await useCase.executeImmediateDeletion('user-1')

    // Sessions revoked BEFORE data deletion
    const revokeOrder = (sessionRepo.revokeAll as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]
    const deleteOrder = (profileRepo.deleteAllData as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]
    expect(revokeOrder).toBeLessThan(deleteOrder!)
    expect(sessionRepo.revokeAll).toHaveBeenCalledWith('user-1')
    expect(profileRepo.deleteAllData).toHaveBeenCalledWith('user-1')
  })
})
