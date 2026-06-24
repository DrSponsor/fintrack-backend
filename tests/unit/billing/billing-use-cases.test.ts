import { describe, expect, it, vi, beforeEach } from 'vitest'
import { CreateCheckoutSessionUseCase } from '../../../src/modules/billing/use-cases/create-checkout-session.use-case'
import { CancelSubscriptionUseCase } from '../../../src/modules/billing/use-cases/cancel-subscription.use-case'
import { GetSubscriptionStatusUseCase } from '../../../src/modules/billing/use-cases/get-subscription-status.use-case'
import { PaystackProvider } from '../../../src/modules/billing/providers/paystack.provider'
import { BillingService } from '../../../src/modules/billing/services/billing.service'
import { SubscriptionService } from '../../../src/modules/billing/services/subscription.service'
import { runSubscriptionSync } from '../../../src/modules/billing/workers/subscription-sync.worker'
import { runGracePeriodDowngrade } from '../../../src/modules/billing/workers/grace-period.worker'
import type { ISubscriptionRepository, SubscriptionRecord, IBillingRepository } from '../../../src/modules/billing/repositories/billing.repo'
import type { IUserRepository, UserRecord } from '../../../src/modules/auth/repositories/user.repo'
import type { IBillingProvider } from '../../../src/modules/billing/providers/billing-provider.interface'
import { NormalizedEventType } from '../../../src/modules/billing/providers/billing-provider.interface'
import { AppError } from '../../../src/core/errors/AppError'

// ──────────────────────────────────────────────────────────────────
// Test Mocks & Setups
// ──────────────────────────────────────────────────────────────────

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
  trace: vi.fn(),
} as any

function makeSubscriptionRecord(overrides: Partial<SubscriptionRecord> = {}): SubscriptionRecord {
  return {
    id: 'sub-1',
    userId: 'user-1',
    provider: 'PAYSTACK',
    providerCustomerId: 'CUS_123',
    providerSubscriptionId: 'SUB_123',
    providerPlanId: 'pro_monthly',
    status: 'ACTIVE',
    currentPeriodStart: new Date(),
    currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    cancelledAt: null,
    gracePeriodEndsAt: null,
    trialEndsAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

function makeUserRecord(overrides: Partial<UserRecord> = {}): UserRecord {
  return {
    id: 'user-1',
    email: 'test@fintrack.ng',
    passwordHash: 'hash',
    googleId: null,
    tier: 'FREE',
    role: 'user',
    createdAt: new Date(),
    ...overrides,
  }
}

function createMockSubscriptionRepo(options: {
  findByUserIdResult?: SubscriptionRecord | null
  findBySubscriptionIdResult?: SubscriptionRecord | null
  upsertResult?: SubscriptionRecord
  findActiveSubscriptionsResult?: readonly SubscriptionRecord[]
  findGracePeriodSubscriptionsResult?: readonly SubscriptionRecord[]
} = {}): ISubscriptionRepository {
  return {
    findByUserId: vi.fn().mockResolvedValue(options.findByUserIdResult ?? null),
    findBySubscriptionId: vi.fn().mockResolvedValue(options.findBySubscriptionIdResult ?? null),
    upsert: vi.fn().mockResolvedValue(options.upsertResult ?? makeSubscriptionRecord()),
    updateStatus: vi.fn().mockResolvedValue(makeSubscriptionRecord()),
    findActiveSubscriptions: vi.fn().mockResolvedValue(options.findActiveSubscriptionsResult ?? []),
    findGracePeriodSubscriptions: vi.fn().mockResolvedValue(options.findGracePeriodSubscriptionsResult ?? []),
  }
}

function createMockUserRepo(user: UserRecord | null = null): IUserRepository {
  return {
    create: vi.fn().mockResolvedValue(user ?? makeUserRecord()),
    findByEmail: vi.fn().mockResolvedValue(user ?? makeUserRecord()),
    findById: vi.fn().mockResolvedValue(user ?? makeUserRecord()),
    updateTier: vi.fn().mockResolvedValue(undefined),
    findByGoogleId: vi.fn().mockResolvedValue(null),
    linkGoogleId: vi.fn().mockResolvedValue(undefined),
  }
}

function createMockBillingProvider(): IBillingProvider {
  return {
    providerName: 'paystack',
    signatureHeaderName: 'x-paystack-signature',
    createCustomer: vi.fn().mockResolvedValue('CUS_123'),
    createCheckoutUrl: vi.fn().mockResolvedValue('https://checkout.paystack.com/mock'),
    verifyWebhookSignature: vi.fn().mockReturnValue(true),
    normalizeWebhookEvent: vi.fn().mockReturnValue({
      providerEventId: 'evt-123',
      normalizedType: NormalizedEventType.SUBSCRIPTION_CREATED,
      userId: 'user-1',
      providerSubscriptionId: 'SUB_123',
      amountKobo: 500000n,
      metadata: {},
    }),
    cancelSubscription: vi.fn().mockResolvedValue(undefined),
    getSubscription: vi.fn().mockResolvedValue({
      status: 'active',
      currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    }),
  }
}

// ──────────────────────────────────────────────────────────────────
// Test Suites
// ──────────────────────────────────────────────────────────────────

describe('Billing Module Use Cases', () => {
  describe('CreateCheckoutSessionUseCase', () => {
    it('creates a checkout URL using BillingService', async () => {
      const userRepo = createMockUserRepo()
      const subscriptionRepo = createMockSubscriptionRepo()
      const billingProvider = createMockBillingProvider()
      const billingService = new BillingService({ billingProvider, subscriptionRepo, userRepo })
      const appConfig = {
        paystackPlanProMonthly: 'PLN_monthly',
        paystackPlanProAnnual: 'PLN_annual',
      } as any

      const useCase = new CreateCheckoutSessionUseCase({ billingService, appConfig })
      const result = await useCase.execute('user-1', {
        planId: 'pro_monthly',
        callbackUrl: 'https://fintrack.ng/callback',
      })

      expect(result.checkoutUrl).toBe('https://checkout.paystack.com/mock')
      expect(billingProvider.createCustomer).toHaveBeenCalledOnce()
      expect(billingProvider.createCheckoutUrl).toHaveBeenCalledWith(
        'test@fintrack.ng',
        'CUS_123',
        expect.objectContaining({
          id: 'pro_monthly',
          providerPlanCode: 'PLN_monthly',
          amountKobo: 500000n,
        }),
        'https://fintrack.ng/callback'
      )
    })
  })

  describe('CancelSubscriptionUseCase', () => {
    it('cancels an active subscription', async () => {
      const sub = makeSubscriptionRecord()
      const subscriptionRepo = createMockSubscriptionRepo({ findByUserIdResult: sub })
      const billingProvider = createMockBillingProvider()

      const useCase = new CancelSubscriptionUseCase({ subscriptionRepo, billingProvider })
      const result = await useCase.execute('user-1')

      expect(result.message).toBe('Subscription successfully cancelled')
      expect(billingProvider.cancelSubscription).toHaveBeenCalledWith('SUB_123')
      expect(subscriptionRepo.updateStatus).toHaveBeenCalledWith('sub-1', 'CANCELLED', expect.any(Object))
    })

    it('throws 404 error if subscription does not exist', async () => {
      const subscriptionRepo = createMockSubscriptionRepo({ findByUserIdResult: null })
      const billingProvider = createMockBillingProvider()

      const useCase = new CancelSubscriptionUseCase({ subscriptionRepo, billingProvider })
      await expect(useCase.execute('user-1')).rejects.toThrow(AppError)
    })
  })

  describe('GetSubscriptionStatusUseCase', () => {
    it('returns NONE if no subscription is found', async () => {
      const subscriptionRepo = createMockSubscriptionRepo({ findByUserIdResult: null })
      const useCase = new GetSubscriptionStatusUseCase({ subscriptionRepo })
      const result = await useCase.execute('user-1')

      expect(result.status).toBe('NONE')
      expect(result.currentPeriodEnd).toBeNull()
    })

    it('returns subscription status and period end', async () => {
      const sub = makeSubscriptionRecord({ status: 'ACTIVE' })
      const subscriptionRepo = createMockSubscriptionRepo({ findByUserIdResult: sub })
      const useCase = new GetSubscriptionStatusUseCase({ subscriptionRepo })
      const result = await useCase.execute('user-1')

      expect(result.status).toBe('ACTIVE')
      expect(result.currentPeriodEnd).toBeInstanceOf(Date)
    })
  })
})

describe('Subscription Service & Workers', () => {
  let mockRedis: any

  beforeEach(() => {
    mockRedis = {
      set: vi.fn().mockResolvedValue('OK'),
      get: vi.fn().mockResolvedValue(null),
    }
  })

  describe('SubscriptionService', () => {
    it('upserts active subscription and updates user tier to PRO', async () => {
      const subscriptionRepo = createMockSubscriptionRepo()
      const userRepo = createMockUserRepo()
      const service = new SubscriptionService({ subscriptionRepo, userRepo, redis: mockRedis, providerName: 'PAYSTACK' })

      const event = {
        providerEventId: 'evt-1',
        normalizedType: NormalizedEventType.SUBSCRIPTION_CREATED,
        userId: 'user-1',
        providerSubscriptionId: 'SUB_123',
        amountKobo: 500000n,
        metadata: {
          planId: 'pro_monthly',
          providerCustomerId: 'CUS_123',
        },
      }

      await service.upsert(event)

      expect(subscriptionRepo.upsert).toHaveBeenCalledWith(expect.objectContaining({
        userId: 'user-1',
        providerCustomerId: 'CUS_123',
        providerSubscriptionId: 'SUB_123',
        providerPlanId: 'pro_monthly',
        status: 'ACTIVE',
      }))
      expect(userRepo.updateTier).toHaveBeenCalledWith('user-1', 'PRO')
      expect(mockRedis.set).toHaveBeenCalledWith('tier-change:user-1', '1', 'EX', 3600)
    })

    it('extends period on payment success', async () => {
      const sub = makeSubscriptionRecord()
      const subscriptionRepo = createMockSubscriptionRepo({ findBySubscriptionIdResult: sub })
      const userRepo = createMockUserRepo()
      const service = new SubscriptionService({ subscriptionRepo, userRepo, redis: mockRedis, providerName: 'PAYSTACK' })

      const event = {
        providerEventId: 'evt-2',
        normalizedType: NormalizedEventType.PAYMENT_SUCCESS,
        userId: 'user-1',
        providerSubscriptionId: 'SUB_123',
        amountKobo: 500000n,
        metadata: {
          current_period_end: '2026-07-18T12:00:00.000Z',
        },
      }

      await service.extendPeriod(event)

      expect(subscriptionRepo.updateStatus).toHaveBeenCalledWith('sub-1', 'ACTIVE', expect.objectContaining({
        currentPeriodEnd: new Date('2026-07-18T12:00:00.000Z'),
        gracePeriodEndsAt: null,
      }))
    })
  })

  describe('Subscription Sync Worker', () => {
    it('syncs active subscription status and updates changed dates', async () => {
      const sub = makeSubscriptionRecord({
        providerSubscriptionId: 'SUB_123',
        currentPeriodEnd: new Date('2026-06-18T12:00:00.000Z'),
      })
      const subscriptionRepo = createMockSubscriptionRepo({ findActiveSubscriptionsResult: [sub] })
      const service = new SubscriptionService({ subscriptionRepo, userRepo: createMockUserRepo(), redis: mockRedis, providerName: 'PAYSTACK' })
      const billingProvider = createMockBillingProvider()
      
      // Paystack returns a new period end
      billingProvider.getSubscription = vi.fn().mockResolvedValue({
        status: 'active',
        currentPeriodEnd: new Date('2026-07-18T12:00:00.000Z'),
      })

      await runSubscriptionSync({
        subscriptionRepo,
        subscriptionService: service,
        billingProvider,
        logger: mockLogger,
      })

      expect(subscriptionRepo.updateStatus).toHaveBeenCalledWith('sub-1', 'ACTIVE', expect.objectContaining({
        currentPeriodEnd: new Date('2026-07-18T12:00:00.000Z'),
      }))
    })

    it('downgrades local subscription if Paystack returns cancelled', async () => {
      const sub = makeSubscriptionRecord({
        providerSubscriptionId: 'SUB_123',
      })
      const subscriptionRepo = createMockSubscriptionRepo({ findActiveSubscriptionsResult: [sub] })
      const service = new SubscriptionService({ subscriptionRepo, userRepo: createMockUserRepo(), redis: mockRedis, providerName: 'PAYSTACK' })
      const billingProvider = createMockBillingProvider()

      // Paystack returns cancelled
      billingProvider.getSubscription = vi.fn().mockResolvedValue({
        status: 'cancelled',
        currentPeriodEnd: new Date('2026-06-18T12:00:00.000Z'),
      })

      const handleCancellationSpy = vi.spyOn(service, 'handleCancellation')

      await runSubscriptionSync({
        subscriptionRepo,
        subscriptionService: service,
        billingProvider,
        logger: mockLogger,
      })

      expect(handleCancellationSpy).toHaveBeenCalledWith('user-1', 'sub-1')
      expect(subscriptionRepo.updateStatus).toHaveBeenCalledWith('sub-1', 'CANCELLED', expect.any(Object))
    })
  })

  describe('Grace Period Worker', () => {
    it('downgrades expired grace period subscriptions', async () => {
      const sub = makeSubscriptionRecord({
        id: 'sub-expired',
        userId: 'user-expired',
        status: 'GRACE_PERIOD',
        gracePeriodEndsAt: new Date(Date.now() - 5000), // expired 5 seconds ago
      })
      const subscriptionRepo = createMockSubscriptionRepo({ findGracePeriodSubscriptionsResult: [sub] })
      const userRepo = createMockUserRepo()
      
      const mockPrisma = {
        $transaction: vi.fn().mockImplementation((arr) => Promise.all(arr)),
        subscription: {
          update: vi.fn().mockResolvedValue({}),
        },
        user: {
          update: vi.fn().mockResolvedValue({}),
        },
      } as any

      const mockQueues = {
        notificationsPush: {
          add: vi.fn().mockResolvedValue({}),
        },
      } as any

      await runGracePeriodDowngrade({
        subscriptionRepo,
        userRepo,
        prisma: mockPrisma,
        redis: mockRedis,
        queues: mockQueues,
        logger: mockLogger,
      })

      expect(mockPrisma.$transaction).toHaveBeenCalledOnce()
      expect(mockPrisma.subscription.update).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: 'sub-expired' },
        data: { status: 'EXPIRED' },
      }))
      expect(mockPrisma.user.update).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: 'user-expired' },
        data: { tier: 'FREE' },
      }))
      expect(mockRedis.set).toHaveBeenCalledWith('tier-change:user-expired', '1', 'EX', 3600)
      expect(mockQueues.notificationsPush.add).toHaveBeenCalledWith(
        'subscription-expired',
        { userId: 'user-expired' },
        expect.any(Object)
      )
    })
  })
})
