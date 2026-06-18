import type { BillingService } from '../services/billing.service'
import type { AppConfig } from '../../../config'

export type CreateCheckoutSessionInput = {
  readonly planId: 'pro_monthly' | 'pro_annual'
  readonly callbackUrl: string
}

export type CreateCheckoutSessionDeps = {
  readonly billingService: BillingService
  readonly appConfig: AppConfig
}

export class CreateCheckoutSessionUseCase {
  private readonly billingService: BillingService
  private readonly appConfig: AppConfig

  public constructor(deps: CreateCheckoutSessionDeps) {
    this.billingService = deps.billingService
    this.appConfig = deps.appConfig
  }

  public async execute(userId: string, input: CreateCheckoutSessionInput): Promise<{ readonly checkoutUrl: string }> {
    const providerPlanCode = input.planId === 'pro_monthly'
      ? this.appConfig.paystackPlanProMonthly || 'PLN_test_monthly'
      : this.appConfig.paystackPlanProAnnual || 'PLN_test_annual'

    const amountKobo = input.planId === 'pro_monthly'
      ? 500000n
      : 5000000n

    const plan = {
      id: input.planId,
      providerPlanCode,
      amountKobo,
      intervalMonths: input.planId === 'pro_monthly' ? 1 : 12,
      trialDays: 0,
    }

    const checkoutUrl = await this.billingService.createCheckoutUrl(
      userId,
      plan,
      input.callbackUrl
    )

    return { checkoutUrl }
  }
}
