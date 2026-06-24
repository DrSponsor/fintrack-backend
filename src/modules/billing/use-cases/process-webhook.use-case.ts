import type { IBillingProvider } from '../providers/billing-provider.interface'
import type { IBillingRepository } from '../repositories/billing.repo'
import type { QueueRegistry } from '../../../core/queue/queues'

export type ProcessWebhookDeps = {
  readonly billingProvider: IBillingProvider
  readonly billingRepo: IBillingRepository
  readonly queues: QueueRegistry
}

export type ProcessWebhookInput = {
  readonly signatureHeader: string | undefined
  readonly rawBody: string | undefined
  readonly body: unknown
}

export class ProcessWebhookUseCase {
  private readonly billingProvider: IBillingProvider
  private readonly billingRepo: IBillingRepository
  private readonly queues: QueueRegistry

  public constructor(deps: ProcessWebhookDeps) {
    this.billingProvider = deps.billingProvider
    this.billingRepo = deps.billingRepo
    this.queues = deps.queues
  }

  public async execute(input: ProcessWebhookInput): Promise<{ readonly received: boolean }> {
    if (!input.signatureHeader) {
      throw new Error('Missing signature header')
    }

    if (!input.rawBody || !this.billingProvider.verifyWebhookSignature(input.rawBody, input.signatureHeader)) {
      throw new Error('Invalid signature')
    }

    const payload = input.body as {
      readonly event?: string
      readonly id?: number | string
      readonly data?: {
        readonly id?: number | string
        readonly reference?: string
      }
    }
    const eventType = payload.event
    if (!eventType) {
      throw new Error('Missing event type in payload')
    }

    const providerEventId = (payload.id || payload.data?.id || payload.data?.reference || '').toString()
    if (!providerEventId) {
      throw new Error('Missing event identifier')
    }

    const normalized = this.billingProvider.normalizeWebhookEvent(payload)

    try {
      await this.billingRepo.create({
        provider: this.billingProvider.providerName.toUpperCase() as 'PAYSTACK' | 'MONNIFY',
        providerEventId,
        eventType,
        normalizedType: normalized.normalizedType,
        userId: normalized.userId,
        payload,
      })
    } catch (err: unknown) {
      if (err !== null && typeof err === 'object' && 'code' in err && (err as { code?: unknown }).code === 'P2002') {
        return { received: true }
      }
      throw err
    }

    await this.queues.billingWebhooks.add(
      'process-webhook',
      { providerEventId },
      { jobId: providerEventId }
    )

    return { received: true }
  }
}
