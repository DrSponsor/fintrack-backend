export interface BillingPlan {
  readonly id: string                // Internal: 'pro_monthly', 'pro_annual'
  readonly providerPlanCode: string  // Provider-specific
  readonly amountKobo: bigint        // BigInt kobo rule (Law 1)
  readonly intervalMonths: number    // 1 = monthly, 12 = annual
  readonly trialDays: number
}

export enum NormalizedEventType {
  SUBSCRIPTION_CREATED   = 'SUBSCRIPTION_CREATED',
  PAYMENT_SUCCESS        = 'PAYMENT_SUCCESS',
  PAYMENT_FAILED         = 'PAYMENT_FAILED',
  SUBSCRIPTION_CANCELLED = 'SUBSCRIPTION_CANCELLED',
  CARD_EXPIRING_SOON     = 'CARD_EXPIRING_SOON',
}

export interface NormalizedBillingEvent {
  readonly providerEventId:         string
  readonly normalizedType:          NormalizedEventType
  readonly userId:                  string | null  // null requires special handling — see worker
  readonly providerSubscriptionId:  string | null
  readonly amountKobo:              bigint | null  // BigInt kobo rule (Law 1)
  readonly metadata:                Record<string, unknown>
}

export interface IBillingProvider {
  readonly providerName: 'paystack' | 'monnify'

  createCustomer(user: { id: string; email: string }): Promise<string>

  createCheckoutUrl(
    email: string,
    providerCustomerId: string,
    plan: BillingPlan,
    callbackUrl: string
  ): Promise<string>

  // Receives the RAW body string — never the parsed object.
  // Fastify parses before the handler runs.
  verifyWebhookSignature(rawBody: string, signatureHeader: string): boolean

  normalizeWebhookEvent(rawPayload: unknown): NormalizedBillingEvent

  cancelSubscription(providerSubscriptionId: string): Promise<void>

  getSubscription(providerSubscriptionId: string): Promise<{
    readonly status: 'active' | 'cancelled' | 'expired'
    readonly currentPeriodEnd: Date
  }>
}
