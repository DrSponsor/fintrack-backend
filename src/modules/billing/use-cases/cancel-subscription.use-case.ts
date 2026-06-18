import type { ISubscriptionRepository } from '../repositories/billing.repo'
import type { IBillingProvider } from '../providers/billing-provider.interface'
import { notFound } from '../../../core/errors/factories'

export type CancelSubscriptionDeps = {
  readonly subscriptionRepo: ISubscriptionRepository
  readonly billingProvider: IBillingProvider
}

export class CancelSubscriptionUseCase {
  private readonly subscriptionRepo: ISubscriptionRepository
  private readonly billingProvider: IBillingProvider

  public constructor(deps: CancelSubscriptionDeps) {
    this.subscriptionRepo = deps.subscriptionRepo
    this.billingProvider = deps.billingProvider
  }

  public async execute(userId: string): Promise<{ readonly message: string }> {
    const sub = await this.subscriptionRepo.findByUserId(userId)
    if (!sub || sub.status === 'EXPIRED') {
      throw notFound('Active subscription not found for this user')
    }

    // Disable on billing provider side
    await this.billingProvider.cancelSubscription(sub.providerSubscriptionId)

    // Mark subscription status CANCELLED locally (will remain PRO tier until period ends)
    await this.subscriptionRepo.updateStatus(sub.id, 'CANCELLED', {
      cancelledAt: new Date(),
    })

    return { message: 'Subscription successfully cancelled' }
  }
}
