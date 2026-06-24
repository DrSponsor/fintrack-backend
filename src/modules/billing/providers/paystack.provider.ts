import CircuitBreaker from 'opossum'
import { createHmac } from 'node:crypto'
import type { IBillingProvider, BillingPlan, NormalizedBillingEvent } from './billing-provider.interface'
import { NormalizedEventType } from './billing-provider.interface'
import { circuitBreakerStateGauge } from '../../../core/observability/metrics'
import { dependencyUnavailable } from '../../../core/errors/factories'

interface PaystackCustomerResponse {
  readonly status: boolean
  readonly message: string
  readonly data: {
    readonly id: number
    readonly customer_code: string
    readonly email: string
  }
}

interface PaystackInitializeResponse {
  readonly status: boolean
  readonly message: string
  readonly data: {
    readonly authorization_url: string
    readonly access_code: string
    readonly reference: string
  }
}

interface PaystackSubscriptionDetailResponse {
  readonly status: boolean
  readonly message: string
  readonly data: {
    readonly id: number
    readonly subscription_code: string
    readonly email_token: string
    readonly status: string
    readonly current_period_end: string
    readonly customer: {
      readonly customer_code: string
      readonly email: string
    }
    readonly plan: {
      readonly plan_code: string
    }
    readonly amount: number
  }
}

export class PaystackProvider implements IBillingProvider {
  public readonly providerName = 'paystack' as const
  public readonly signatureHeaderName = 'x-paystack-signature' as const
  private readonly secretKey: string
  private readonly breaker: CircuitBreaker<[string, RequestInit], any>

  public constructor(secretKey: string) {
    this.secretKey = secretKey
    
    // Circuit breaker for external API calls to Paystack
    this.breaker = new CircuitBreaker(
      this.callPaystackApi.bind(this),
      {
        timeout: 10000, // 10 seconds timeout
        errorThresholdPercentage: 50,
        resetTimeout: 30000,
      }
    )

    this.breaker.on('open', () => circuitBreakerStateGauge.set({ name: 'paystack' }, 1))
    this.breaker.on('close', () => circuitBreakerStateGauge.set({ name: 'paystack' }, 0))
    this.breaker.on('halfOpen', () => circuitBreakerStateGauge.set({ name: 'paystack' }, 2))

    circuitBreakerStateGauge.set({ name: 'paystack' }, 0)
  }

  private async callPaystackApi(path: string, options: RequestInit): Promise<any> {
    if (!this.secretKey || this.secretKey.length === 0 || this.secretKey === 'ts_paystack_secret_key_fallback') {
      throw new Error('PAYSTACK_SECRET_KEY is not configured')
    }

    const url = `https://api.paystack.co${path}`
    const headers = {
      'Authorization': `Bearer ${this.secretKey}`,
      'Content-Type': 'application/json',
      ...options.headers,
    }

    const response = await fetch(url, {
      ...options,
      headers,
    })

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error')
      throw new Error(`Paystack API error [${response.status}]: ${errorText}`)
    }

    return response.json()
  }

  public async createCustomer(user: { id: string; email: string }): Promise<string> {
    try {
      const res: PaystackCustomerResponse = await this.breaker.fire('/customer', {
        method: 'POST',
        body: JSON.stringify({
          email: user.email,
          metadata: { userId: user.id },
        }),
      })

      if (!res.status || !res.data?.customer_code) {
        throw new Error('Invalid response from Paystack createCustomer')
      }

      return res.data.customer_code
    } catch (err) {
      throw dependencyUnavailable('Billing provider service is temporarily unavailable')
    }
  }

  public async createCheckoutUrl(
    email: string,
    providerCustomerId: string,
    plan: BillingPlan,
    callbackUrl: string
  ): Promise<string> {
    try {
      // In Paystack, amount is sent in kobo. Plan amount overrides initialize amount,
      // but passing it is safe.
      const res: PaystackInitializeResponse = await this.breaker.fire('/transaction/initialize', {
        method: 'POST',
        body: JSON.stringify({
          email,
          amount: plan.amountKobo.toString(),
          plan: plan.providerPlanCode,
          callback_url: callbackUrl,
          metadata: {
            providerCustomerId,
            planId: plan.id,
          },
        }),
      })

      if (!res.status || !res.data?.authorization_url) {
        throw new Error('Invalid response from Paystack transaction initialize')
      }

      return res.data.authorization_url
    } catch (err) {
      throw dependencyUnavailable('Billing provider service is temporarily unavailable')
    }
  }

  public verifyWebhookSignature(rawBody: string, signatureHeader: string): boolean {
    if (!this.secretKey || this.secretKey.length === 0 || this.secretKey === 'ts_paystack_secret_key_fallback') {
      return false
    }
    const hash = createHmac('sha512', this.secretKey).update(rawBody).digest('hex')
    return hash === signatureHeader
  }

  public normalizeWebhookEvent(rawPayload: unknown): NormalizedBillingEvent {
    const payload = rawPayload as {
      readonly event?: string
      readonly id?: number | string
      readonly data?: {
        readonly id?: number | string
        readonly reference?: string
        readonly status?: string
        readonly amount?: number | string
        readonly customer?: {
          readonly email?: string
          readonly customer_code?: string
          readonly metadata?: { readonly userId?: string }
        }
        readonly subscription_code?: string
        readonly subscription?: {
          readonly subscription_code?: string
        }
        readonly metadata?: {
          readonly userId?: string
          readonly planId?: string
          readonly providerCustomerId?: string
          readonly current_period_end?: string
        }
      }
    }
    const eventType = payload.event || ''
    const data = payload.data || {}

    // Extract ID safely
    const providerEventId = (payload.id || data.id || data.reference || '').toString()

    // Determine normalized event type
    let normalizedType: NormalizedEventType
    switch (eventType) {
      case 'subscription.create':
        normalizedType = NormalizedEventType.SUBSCRIPTION_CREATED
        break
      case 'charge.success':
        normalizedType = NormalizedEventType.PAYMENT_SUCCESS
        break
      case 'invoice.update':
        // If invoice is paid, it represents a successful subscription payment
        if (data.status === 'success') {
          normalizedType = NormalizedEventType.PAYMENT_SUCCESS
        } else if (data.status === 'failed') {
          normalizedType = NormalizedEventType.PAYMENT_FAILED
        } else {
          // Fallback if invoice update is not a final status
          normalizedType = NormalizedEventType.PAYMENT_SUCCESS
        }
        break
      case 'invoice.payment_failed':
        normalizedType = NormalizedEventType.PAYMENT_FAILED
        break
      case 'subscription.disable':
        normalizedType = NormalizedEventType.SUBSCRIPTION_CANCELLED
        break
      default:
        // Default fallbacks
        if (eventType.includes('payment_failed') || eventType.includes('failed')) {
          normalizedType = NormalizedEventType.PAYMENT_FAILED
        } else if (eventType.includes('expiring')) {
          normalizedType = NormalizedEventType.CARD_EXPIRING_SOON
        } else {
          normalizedType = NormalizedEventType.PAYMENT_SUCCESS
        }
    }

    // Extract customer email to look up userId
    const email = data.customer?.email as string | undefined
    // Check if userId is passed in metadata
    let userId: string | null = null
    const metadata = data.metadata || {}
    if (typeof metadata.userId === 'string') {
      userId = metadata.userId
    } else if (data.customer?.metadata?.userId) {
      userId = data.customer.metadata.userId
    }

    // Fetch subscription ID
    const providerSubscriptionId = (data.subscription_code || data.subscription?.subscription_code || null) as string | null

    // Extract amount
    const amountKobo = data.amount ? BigInt(data.amount) : null

    return {
      providerEventId,
      normalizedType,
      userId,
      providerSubscriptionId,
      amountKobo,
      metadata: {
        email,
        rawEvent: eventType,
        ...metadata,
      },
    }
  }

  public async cancelSubscription(providerSubscriptionId: string): Promise<void> {
    try {
      // 1. Fetch email_token first
      const subDetails: PaystackSubscriptionDetailResponse = await this.breaker.fire(`/subscription/${providerSubscriptionId}`, {
        method: 'GET',
      })

      if (!subDetails.status || !subDetails.data?.email_token) {
        throw new Error('Failed to retrieve subscription email token for cancellation')
      }

      const emailToken = subDetails.data.email_token

      // 2. Disable subscription
      const res = await this.breaker.fire('/subscription/disable', {
        method: 'POST',
        body: JSON.stringify({
          code: providerSubscriptionId,
          token: emailToken,
        }),
      })

      if (!res.status) {
        throw new Error('Paystack disable subscription returned status false')
      }
    } catch (err) {
      throw dependencyUnavailable('Billing provider service is temporarily unavailable during cancellation')
    }
  }

  public async getSubscription(providerSubscriptionId: string): Promise<{
    readonly status: 'active' | 'cancelled' | 'expired'
    readonly currentPeriodEnd: Date
  }> {
    try {
      const res: PaystackSubscriptionDetailResponse = await this.breaker.fire(`/subscription/${providerSubscriptionId}`, {
        method: 'GET',
      })

      if (!res.status || !res.data) {
        throw new Error('Failed to fetch subscription details')
      }

      const paystackStatus = res.data.status
      let status: 'active' | 'cancelled' | 'expired'

      if (paystackStatus === 'active' || paystackStatus === 'non-renewing') {
        status = 'active'
      } else if (paystackStatus === 'cancelled' || paystackStatus === 'completed') {
        status = 'cancelled'
      } else {
        status = 'expired'
      }

      return {
        status,
        currentPeriodEnd: new Date(res.data.current_period_end),
      }
    } catch (err) {
      throw dependencyUnavailable('Billing provider service is temporarily unavailable')
    }
  }
}
