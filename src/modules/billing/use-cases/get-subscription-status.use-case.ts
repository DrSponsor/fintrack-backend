import type { ISubscriptionRepository } from '../repositories/billing.repo'

export type SubscriptionStatus = 'ACTIVE' | 'GRACE_PERIOD' | 'CANCELLED' | 'EXPIRED'

export type GetSubscriptionStatusDeps = {
  readonly subscriptionRepo: ISubscriptionRepository
}

export type SubscriptionStatusResult = {
  readonly status: SubscriptionStatus | 'NONE'
  readonly currentPeriodEnd: Date | null
}

export class GetSubscriptionStatusUseCase {
  private readonly subscriptionRepo: ISubscriptionRepository

  public constructor(deps: GetSubscriptionStatusDeps) {
    this.subscriptionRepo = deps.subscriptionRepo
  }

  public async execute(userId: string): Promise<SubscriptionStatusResult> {
    const sub = await this.subscriptionRepo.findByUserId(userId)
    if (!sub) {
      return {
        status: 'NONE',
        currentPeriodEnd: null,
      }
    }

    return {
      status: sub.status,
      currentPeriodEnd: sub.currentPeriodEnd,
    }
  }
}
