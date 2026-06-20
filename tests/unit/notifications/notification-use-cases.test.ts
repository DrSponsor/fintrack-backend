import { describe, expect, it, vi } from 'vitest'
import { RegisterTokenUseCase } from '../../../src/modules/notifications/use-cases/register-token.use-case'
import { UnregisterTokenUseCase } from '../../../src/modules/notifications/use-cases/unregister-token.use-case'
import { GetPreferencesUseCase } from '../../../src/modules/notifications/use-cases/get-preferences.use-case'
import { UpdatePreferencesUseCase } from '../../../src/modules/notifications/use-cases/update-preferences.use-case'
import { NotificationService } from '../../../src/modules/notifications/services/notification.service'
import type { INotificationRepository, DeviceTokenRecord, NotificationPreferenceRecord } from '../../../src/modules/notifications/repositories/notification.repo'
import type { IPushProvider } from '../../../src/modules/notifications/providers/fcm.provider'
import type { IEmailProvider } from '../../../src/modules/notifications/providers/postmark.provider'
import type { IUserRepository } from '../../../src/modules/auth/repositories/user.repo'
import type { ICategoryRepository } from '../../../src/modules/categories/repositories/category.repo'
import { randomUUID } from 'node:crypto'
import { AppError } from '../../../src/core/errors/AppError'

const silentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
  trace: vi.fn(),
} as any

function createMockNotificationRepo(overrides: Partial<INotificationRepository> = {}): INotificationRepository {
  return {
    registerToken: vi.fn().mockResolvedValue({
      id: randomUUID(),
      userId: randomUUID(),
      token: 'fake-token',
      platform: 'ANDROID',
      createdAt: new Date(),
      updatedAt: new Date(),
    } as DeviceTokenRecord),
    unregisterToken: vi.fn().mockResolvedValue(undefined),
    getTokensByUserId: vi.fn().mockResolvedValue([]),
    getPreferences: vi.fn().mockResolvedValue({
      id: randomUUID(),
      userId: randomUUID(),
      budgetAlerts: true,
      paymentFailures: true,
      subscriptionExpiring: true,
      weeklyReports: true,
      monthlyReports: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as NotificationPreferenceRecord),
    updatePreferences: vi.fn().mockImplementation((userId, data) => Promise.resolve({
      id: randomUUID(),
      userId,
      budgetAlerts: true,
      paymentFailures: true,
      subscriptionExpiring: true,
      weeklyReports: true,
      monthlyReports: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...data,
    } as NotificationPreferenceRecord)),
    ...overrides,
  }
}

function createMockPushProvider(): IPushProvider {
  return {
    sendPush: vi.fn().mockResolvedValue(undefined),
  }
}

function createMockEmailProvider(): IEmailProvider {
  return {
    sendEmail: vi.fn().mockResolvedValue(undefined),
  }
}

function createMockUserRepo(): IUserRepository {
  return {
    create: vi.fn(),
    findByEmail: vi.fn(),
    findById: vi.fn().mockResolvedValue({
      id: randomUUID(),
      email: 'test@fintrack.ng',
      passwordHash: 'hash',
      tier: 'FREE',
      role: 'user',
      createdAt: new Date(),
    }),
    updateTier: vi.fn(),
  } as any
}

function createMockCategoryRepo(): ICategoryRepository {
  return {
    findAll: vi.fn().mockResolvedValue([]),
    findById: vi.fn().mockResolvedValue({
      id: randomUUID(),
      name: 'Food',
      icon: 'food-icon',
    }),
  }
}

describe('RegisterTokenUseCase', () => {
  it('registers a device token successfully', async () => {
    const userId = randomUUID()
    const notificationRepo = createMockNotificationRepo()
    const useCase = new RegisterTokenUseCase({ notificationRepo, logger: silentLogger })

    const result = await useCase.execute(userId, {
      token: 'fcm-token-123',
      platform: 'IOS',
    })

    expect(result.token).toBe('fake-token')
    expect(notificationRepo.registerToken).toHaveBeenCalledWith(userId, 'fcm-token-123', 'IOS')
  })

  it('fails with validation error on empty token', async () => {
    const useCase = new RegisterTokenUseCase({
      notificationRepo: createMockNotificationRepo(),
      logger: silentLogger,
    })

    await expect(
      useCase.execute(randomUUID(), { token: '', platform: 'ANDROID' })
    ).rejects.toThrow(AppError)
  })

  it('fails with validation error on invalid platform', async () => {
    const useCase = new RegisterTokenUseCase({
      notificationRepo: createMockNotificationRepo(),
      logger: silentLogger,
    })

    await expect(
      useCase.execute(randomUUID(), { token: 'tok', platform: 'WEB' })
    ).rejects.toThrow(AppError)
  })
})

describe('UnregisterTokenUseCase', () => {
  it('unregisters token successfully', async () => {
    const userId = randomUUID()
    const notificationRepo = createMockNotificationRepo()
    const useCase = new UnregisterTokenUseCase({ notificationRepo, logger: silentLogger })

    await useCase.execute(userId, { token: 'tok-123' })
    expect(notificationRepo.unregisterToken).toHaveBeenCalledWith(userId, 'tok-123')
  })
})

describe('Preferences Use Cases', () => {
  it('GetPreferencesUseCase returns preferences', async () => {
    const userId = randomUUID()
    const notificationRepo = createMockNotificationRepo()
    const useCase = new GetPreferencesUseCase({ notificationRepo, logger: silentLogger })

    const res = await useCase.execute(userId)
    expect(res.budgetAlerts).toBe(true)
    expect(notificationRepo.getPreferences).toHaveBeenCalledWith(userId)
  })

  it('UpdatePreferencesUseCase updates preferences successfully', async () => {
    const userId = randomUUID()
    const notificationRepo = createMockNotificationRepo()
    const useCase = new UpdatePreferencesUseCase({ notificationRepo, logger: silentLogger })

    const res = await useCase.execute(userId, { budgetAlerts: false })
    expect(res.budgetAlerts).toBe(false)
    expect(notificationRepo.updatePreferences).toHaveBeenCalledWith(userId, { budgetAlerts: false })
  })

  it('UpdatePreferencesUseCase throws validation error if empty update', async () => {
    const useCase = new UpdatePreferencesUseCase({
      notificationRepo: createMockNotificationRepo(),
      logger: silentLogger,
    })

    await expect(useCase.execute(randomUUID(), {})).rejects.toThrow(AppError)
  })
})

describe('NotificationService', () => {
  it('sends budget alert if user opted-in', async () => {
    const userId = randomUUID()
    const notificationRepo = createMockNotificationRepo({
      getTokensByUserId: vi.fn().mockResolvedValue([{ token: 'token-abc' }]),
    })
    const pushProvider = createMockPushProvider()
    const emailProvider = createMockEmailProvider()
    const userRepo = createMockUserRepo()
    const categoryRepo = createMockCategoryRepo()

    const service = new NotificationService({
      notificationRepo,
      pushProvider,
      emailProvider,
      userRepo,
      categoryRepo,
      logger: silentLogger,
    })

    await service.sendBudgetAlert(userId, 'budget-1', 'category-food', 12000n, 10000n)
    
    expect(pushProvider.sendPush).toHaveBeenCalledWith({
      token: 'token-abc',
      title: 'Budget Limit Breached',
      body: expect.stringContaining("Food"),
      data: { type: 'budget_breached', budgetId: 'budget-1' },
    })
  })

  it('skips budget alert if user opted-out', async () => {
    const userId = randomUUID()
    const notificationRepo = createMockNotificationRepo({
      getPreferences: vi.fn().mockResolvedValue({ budgetAlerts: false }),
    })
    const pushProvider = createMockPushProvider()
    const emailProvider = createMockEmailProvider()
    const userRepo = createMockUserRepo()
    const categoryRepo = createMockCategoryRepo()

    const service = new NotificationService({
      notificationRepo,
      pushProvider,
      emailProvider,
      userRepo,
      categoryRepo,
      logger: silentLogger,
    })

    await service.sendBudgetAlert(userId, 'budget-1', 'category-food', 12000n, 10000n)
    expect(pushProvider.sendPush).not.toHaveBeenCalled()
  })

  it('sends payment failure push and email if opted-in', async () => {
    const userId = randomUUID()
    const notificationRepo = createMockNotificationRepo({
      getTokensByUserId: vi.fn().mockResolvedValue([{ token: 'tok' }]),
    })
    const pushProvider = createMockPushProvider()
    const emailProvider = createMockEmailProvider()
    const userRepo = createMockUserRepo()
    const categoryRepo = createMockCategoryRepo()

    const service = new NotificationService({
      notificationRepo,
      pushProvider,
      emailProvider,
      userRepo,
      categoryRepo,
      logger: silentLogger,
    })

    await service.sendPaymentFailed(userId)

    expect(pushProvider.sendPush).toHaveBeenCalledOnce()
    expect(emailProvider.sendEmail).toHaveBeenCalledOnce()
  })

  it('sends NDPR deletion email even if user preferences are missing or opted-out (no opt-out boundary check)', async () => {
    const userId = randomUUID()
    const notificationRepo = createMockNotificationRepo() // preferences won't be read
    const pushProvider = createMockPushProvider()
    const emailProvider = createMockEmailProvider()
    const userRepo = createMockUserRepo()
    const categoryRepo = createMockCategoryRepo()

    const service = new NotificationService({
      notificationRepo,
      pushProvider,
      emailProvider,
      userRepo,
      categoryRepo,
      logger: silentLogger,
    })

    await service.sendDataDeletionConfirmation(userId, 'deleted@user.com')

    expect(notificationRepo.getPreferences).not.toHaveBeenCalled()
    expect(emailProvider.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'deleted@user.com',
        subject: expect.stringContaining('NDPR'),
      })
    )
  })
})
