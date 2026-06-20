import { describe, expect, it, vi, beforeEach } from 'vitest'
import { InitiateDeletionUseCase } from '../../../src/modules/privacy/use-cases/initiate-deletion.use-case'
import { CancelDeletionUseCase } from '../../../src/modules/privacy/use-cases/cancel-deletion.use-case'
import { InitiateExportUseCase } from '../../../src/modules/privacy/use-cases/initiate-export.use-case'
import type { IPrivacyRepository } from '../../../src/modules/privacy/repositories/privacy.repo'
import { AppError } from '../../../src/core/errors/AppError'

// ──────────────────────────────────────────────────────────────────
// Test Mocks
// ──────────────────────────────────────────────────────────────────

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
  trace: vi.fn(),
} as any

function createMockPrivacyRepo(): IPrivacyRepository {
  return {
    scheduleDeletion: vi.fn().mockResolvedValue(undefined),
    cancelDeletion: vi.fn().mockResolvedValue(undefined),
    getDeletionScheduledAt: vi.fn().mockResolvedValue(null),
    getUserExportData: vi.fn().mockResolvedValue(null),
    executeAccountDeletion: vi.fn().mockResolvedValue(undefined),
  }
}

function createMockQueues() {
  return {
    privacyDeletion: {
      add: vi.fn().mockResolvedValue({ id: 'job-1' }),
      getJob: vi.fn().mockResolvedValue(null),
    },
    privacyExport: {
      add: vi.fn().mockResolvedValue({ id: 'job-2' }),
    },
  } as any
}

// ──────────────────────────────────────────────────────────────────
// InitiateDeletionUseCase
// ──────────────────────────────────────────────────────────────────

describe('InitiateDeletionUseCase', () => {
  let privacyRepo: IPrivacyRepository
  let mockQueues: ReturnType<typeof createMockQueues>
  let useCase: InitiateDeletionUseCase

  beforeEach(() => {
    vi.clearAllMocks()
    privacyRepo = createMockPrivacyRepo()
    mockQueues = createMockQueues()
    useCase = new InitiateDeletionUseCase({
      privacyRepo,
      queues: mockQueues,
      logger: mockLogger,
    })
  })

  it('should schedule deletion 24 hours from now and queue a delayed job', async () => {
    const before = Date.now()
    const result = await useCase.execute('user-1')
    const after = Date.now()

    // Verify scheduledAt is ~24 hours from now
    const scheduledMs = result.scheduledAt.getTime()
    const expectedMs = 24 * 60 * 60 * 1_000
    expect(scheduledMs).toBeGreaterThanOrEqual(before + expectedMs - 100)
    expect(scheduledMs).toBeLessThanOrEqual(after + expectedMs + 100)

    // Verify repo was called
    expect(privacyRepo.scheduleDeletion).toHaveBeenCalledOnce()
    expect(privacyRepo.scheduleDeletion).toHaveBeenCalledWith('user-1', result.scheduledAt)

    // Verify BullMQ job was queued with delay
    expect(mockQueues.privacyDeletion.add).toHaveBeenCalledOnce()
    const [jobName, jobData, jobOpts] = (mockQueues.privacyDeletion.add as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(jobName).toBe('execute-deletion')
    expect(jobData).toEqual({ userId: 'user-1' })
    expect(jobOpts.jobId).toBe('deletion-user-1')
    expect(jobOpts.delay).toBe(24 * 60 * 60 * 1_000)

    // Verify result message
    expect(result.message).toContain('permanently deleted')
    expect(result.message).toContain('cancel')
  })

  it('should throw DELETION_PENDING if deletion is already scheduled', async () => {
    const futureDate = new Date(Date.now() + 12 * 60 * 60 * 1_000)
    vi.mocked(privacyRepo.getDeletionScheduledAt).mockResolvedValue(futureDate)

    await expect(useCase.execute('user-1')).rejects.toThrow(AppError)
    await expect(useCase.execute('user-1')).rejects.toMatchObject({
      code: 'FINTRACK_ERR_4094',
    })

    // Verify no job was queued
    expect(mockQueues.privacyDeletion.add).not.toHaveBeenCalled()
    expect(privacyRepo.scheduleDeletion).not.toHaveBeenCalled()
  })
})

// ──────────────────────────────────────────────────────────────────
// CancelDeletionUseCase
// ──────────────────────────────────────────────────────────────────

describe('CancelDeletionUseCase', () => {
  let privacyRepo: IPrivacyRepository
  let mockQueues: ReturnType<typeof createMockQueues>
  let useCase: CancelDeletionUseCase

  beforeEach(() => {
    vi.clearAllMocks()
    privacyRepo = createMockPrivacyRepo()
    mockQueues = createMockQueues()
    useCase = new CancelDeletionUseCase({
      privacyRepo,
      queues: mockQueues,
      logger: mockLogger,
    })
  })

  it('should cancel deletion and remove the queued job', async () => {
    const scheduledDate = new Date(Date.now() + 12 * 60 * 60 * 1_000)
    vi.mocked(privacyRepo.getDeletionScheduledAt).mockResolvedValue(scheduledDate)

    const mockJob = { remove: vi.fn().mockResolvedValue(undefined) }
    vi.mocked(mockQueues.privacyDeletion.getJob).mockResolvedValue(mockJob)

    const result = await useCase.execute('user-1')

    expect(privacyRepo.cancelDeletion).toHaveBeenCalledWith('user-1')
    expect(mockQueues.privacyDeletion.getJob).toHaveBeenCalledWith('deletion-user-1')
    expect(mockJob.remove).toHaveBeenCalledOnce()
    expect(result.message).toContain('cancelled')
  })

  it('should throw CONFLICT if no deletion is pending', async () => {
    vi.mocked(privacyRepo.getDeletionScheduledAt).mockResolvedValue(null)

    await expect(useCase.execute('user-1')).rejects.toThrow(AppError)
    await expect(useCase.execute('user-1')).rejects.toMatchObject({
      code: 'FINTRACK_ERR_4090',
    })

    expect(privacyRepo.cancelDeletion).not.toHaveBeenCalled()
  })

  it('should warn but succeed if queue job is not found (already processed)', async () => {
    const scheduledDate = new Date(Date.now() + 12 * 60 * 60 * 1_000)
    vi.mocked(privacyRepo.getDeletionScheduledAt).mockResolvedValue(scheduledDate)
    vi.mocked(mockQueues.privacyDeletion.getJob).mockResolvedValue(null)

    const result = await useCase.execute('user-1')

    expect(privacyRepo.cancelDeletion).toHaveBeenCalledWith('user-1')
    expect(mockLogger.warn).toHaveBeenCalled()
    expect(result.message).toContain('cancelled')
  })
})

// ──────────────────────────────────────────────────────────────────
// InitiateExportUseCase
// ──────────────────────────────────────────────────────────────────

describe('InitiateExportUseCase', () => {
  let mockQueues: ReturnType<typeof createMockQueues>
  let useCase: InitiateExportUseCase

  beforeEach(() => {
    vi.clearAllMocks()
    mockQueues = createMockQueues()
    useCase = new InitiateExportUseCase({
      queues: mockQueues,
      logger: mockLogger,
    })
  })

  it('should queue an export job and return a confirmation message', async () => {
    const result = await useCase.execute('user-1', 'test@fintrack.ng')

    expect(mockQueues.privacyExport.add).toHaveBeenCalledOnce()
    const [jobName, jobData] = (mockQueues.privacyExport.add as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(jobName).toBe('generate-export')
    expect(jobData).toEqual({ userId: 'user-1', email: 'test@fintrack.ng' })

    expect(result.message).toContain('data export')
    expect(result.message).toContain('email')
  })
})
