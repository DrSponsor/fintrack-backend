import type { IBillingProvider, BillingPlan } from '../providers/billing-provider.interface'
import type { ISubscriptionRepository } from '../repositories/billing.repo'
import type { IUserRepository } from '../../auth/repositories/user.repo'
import { notFound } from '../../../core/errors/factories'

export type BillingServiceDeps = {
  readonly billingProvider: IBillingProvider
  readonly subscriptionRepo: ISubscriptionRepository
  readonly userRepo: IUserRepository
}

export class BillingService {
  private readonly billingProvider: IBillingProvider
  private readonly subscriptionRepo: ISubscriptionRepository
  private readonly userRepo: IUserRepository

  public constructor(deps: BillingServiceDeps) {
    this.billingProvider = deps.billingProvider
    this.subscriptionRepo = deps.subscriptionRepo
    this.userRepo = deps.userRepo
  }

  public async createCheckoutUrl(
    userId: string,
    plan: BillingPlan,
    callbackUrl: string
  ): Promise<string> {
    const existing = await this.subscriptionRepo.findByUserId(userId)
    let providerCustomerId: string
    let email: string

    if (existing) {
      providerCustomerId = existing.providerCustomerId
      const user = await this.userRepo.findById(userId)
      if (!user) {
        throw notFound('User not found')
      }
      email = user.email
    } else {
      const user = await this.userRepo.findById(userId)
      if (!user) {
        throw notFound('User not found')
      }
      email = user.email
      // Create customer on billing provider
      providerCustomerId = await this.billingProvider.createCustomer(user)
    }

    return this.billingProvider.createCheckoutUrl(
      email,
      providerCustomerId,
      plan,
      callbackUrl
    )
  }
}
