import type { Redis } from 'ioredis'
import type { BillingProvider } from '../../../generated/prisma/client'
import type { NormalizedBillingEvent } from '../providers/billing-provider.interface'
import type { ISubscriptionRepository } from '../repositories/billing.repo'
import type { IUserRepository } from '../../auth/repositories/user.repo'

export type SubscriptionServiceDeps = {
  readonly subscriptionRepo: ISubscriptionRepository
  readonly userRepo: IUserRepository
  readonly redis: Redis
  readonly providerName: BillingProvider
}

export class SubscriptionService {
  private readonly subscriptionRepo: ISubscriptionRepository
  private readonly userRepo: IUserRepository
  private readonly redis: Redis
  private readonly providerName: BillingProvider

  public constructor(deps: SubscriptionServiceDeps) {
    this.subscriptionRepo = deps.subscriptionRepo
    this.userRepo = deps.userRepo
    this.redis = deps.redis
    this.providerName = deps.providerName
  }

  public async upsert(event: NormalizedBillingEvent): Promise<void> {
    if (!event.userId) return

    const planId = (event.metadata.planId as string | undefined) || 'pro_monthly'
    const providerCustomerId = (event.metadata.providerCustomerId as string | undefined) || 'unknown'
    const providerSubscriptionId = event.providerSubscriptionId || 'unknown'

    // Save/update subscription record in DB — provider is injected at construction
    await this.subscriptionRepo.upsert({
      userId: event.userId,
      provider: this.providerName,
      providerCustomerId,
      providerSubscriptionId,
      providerPlanId: planId,
      status: 'ACTIVE',
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // Default 30 days
    })

    // Transition user tier to PRO
    await this.userRepo.updateTier(event.userId, 'PRO')

    // Set tier-change signal in Redis with 1-hour TTL
    await this.redis.set(`tier-change:${event.userId}`, '1', 'EX', 3600)
  }

  public async extendPeriod(event: NormalizedBillingEvent): Promise<void> {
    if (!event.userId || !event.providerSubscriptionId) return

    const sub = await this.subscriptionRepo.findBySubscriptionId(event.providerSubscriptionId)
    if (!sub) return

    const currentPeriodEnd = typeof event.metadata.current_period_end === 'string'
      ? new Date(event.metadata.current_period_end)
      : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)

    await this.subscriptionRepo.updateStatus(sub.id, 'ACTIVE', {
      currentPeriodEnd,
      gracePeriodEndsAt: null,
    })

    await this.userRepo.updateTier(event.userId, 'PRO')
    await this.redis.set(`tier-change:${event.userId}`, '1', 'EX', 3600)
  }

  public async setGracePeriod(userId: string, days: number): Promise<void> {
    const sub = await this.subscriptionRepo.findByUserId(userId)
    if (!sub) return

    const gracePeriodEndsAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000)
    await this.subscriptionRepo.updateStatus(sub.id, 'GRACE_PERIOD', {
      gracePeriodEndsAt,
    })

    await this.userRepo.updateTier(userId, 'PRO') // Still PRO during grace period
    await this.redis.set(`tier-change:${userId}`, '1', 'EX', 3600)
  }

  public async clearGracePeriod(userId: string): Promise<void> {
    const sub = await this.subscriptionRepo.findByUserId(userId)
    if (!sub) return

    await this.subscriptionRepo.updateStatus(sub.id, 'ACTIVE', {
      gracePeriodEndsAt: null,
    })

    await this.userRepo.updateTier(userId, 'PRO')
    await this.redis.set(`tier-change:${userId}`, '1', 'EX', 3600)
  }

  public async markCancelled(event: NormalizedBillingEvent): Promise<void> {
    if (!event.providerSubscriptionId) return

    const sub = await this.subscriptionRepo.findBySubscriptionId(event.providerSubscriptionId)
    if (!sub) return

    await this.subscriptionRepo.updateStatus(sub.id, 'CANCELLED', {
      cancelledAt: new Date(),
    })
  }

  public async handleCancellation(userId: string, id: string): Promise<void> {
    await this.subscriptionRepo.updateStatus(id, 'CANCELLED', {
      cancelledAt: new Date(),
    })
    await this.redis.set(`tier-change:${userId}`, '1', 'EX', 3600)
  }
}
