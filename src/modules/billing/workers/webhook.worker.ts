import type { ConnectionOptions, Job } from 'bullmq'
import type { Redis } from 'ioredis'
import type { PrismaClient } from '../../../generated/prisma/client'
import type { IUserRepository } from '../../auth/repositories/user.repo'
import type { ISubscriptionRepository } from '../repositories/billing.repo'
import { runSubscriptionSync } from './subscription-sync.worker'
import { runGracePeriodDowngrade } from './grace-period.worker'
import { BaseWorker } from '../../../core/queue/base-worker'
import { QUEUE_NAMES } from '../../../core/queue/queues'
import type { IBillingRepository } from '../repositories/billing.repo'
import type { SubscriptionService } from '../services/subscription.service'
import type { IBillingProvider } from '../providers/billing-provider.interface'
import { NormalizedEventType } from '../providers/billing-provider.interface'
import type { AppLogger } from '../../../core/logger'
import { webhooksUnresolvableTotal } from '../../../core/observability/metrics'
import type { QueueRegistry } from '../../../core/queue/queues'

export type WebhookJobData = {
  readonly providerEventId: string
}

export type WebhookWorkerDeps = {
  readonly connection: ConnectionOptions
  readonly concurrency: number
  readonly logger: AppLogger
  readonly billingRepo: IBillingRepository
  readonly subscriptionRepo: ISubscriptionRepository
  readonly userRepo: IUserRepository
  readonly subscriptionService: SubscriptionService
  readonly billingProvider: IBillingProvider
  readonly prisma: PrismaClient
  readonly redis: Redis
  readonly queues: QueueRegistry
}

export class BillingWebhookWorker extends BaseWorker<any, void> {
  private readonly billingRepo: IBillingRepository
  private readonly subscriptionRepo: ISubscriptionRepository
  private readonly userRepo: IUserRepository
  private readonly subscriptionService: SubscriptionService
  private readonly billingProvider: IBillingProvider
  private readonly prisma: PrismaClient
  private readonly redis: Redis
  private readonly logger: AppLogger
  private readonly queues: QueueRegistry

  public constructor(deps: WebhookWorkerDeps) {
    super({
      queueName: QUEUE_NAMES.billingWebhooks,
      connection: deps.connection,
      concurrency: deps.concurrency,
      logger: deps.logger,
      processor: async (job: Job<any>) => {
        if (job.name === 'sync-subscriptions') {
          await runSubscriptionSync({
            subscriptionRepo: this.subscriptionRepo,
            subscriptionService: this.subscriptionService,
            billingProvider: this.billingProvider,
            logger: this.logger,
          })
        } else if (job.name === 'downgrade-grace-period') {
          await runGracePeriodDowngrade({
            subscriptionRepo: this.subscriptionRepo,
            userRepo: this.userRepo,
            prisma: this.prisma,
            redis: this.redis,
            queues: this.queues,
            logger: this.logger,
          })
        } else {
          const { providerEventId } = job.data as WebhookJobData
          await this.processWebhookEvent(providerEventId)
        }
      },
    })

    this.billingRepo = deps.billingRepo
    this.subscriptionRepo = deps.subscriptionRepo
    this.userRepo = deps.userRepo
    this.subscriptionService = deps.subscriptionService
    this.billingProvider = deps.billingProvider
    this.prisma = deps.prisma
    this.redis = deps.redis
    this.logger = deps.logger
    this.queues = deps.queues
  }

  private async processWebhookEvent(providerEventId: string): Promise<void> {
    const payload = await this.billingRepo.getPayload(providerEventId)
    if (!payload) {
      this.logger.error({ providerEventId }, 'Webhook payload not found in repository')
      throw new Error(`Webhook payload not found: ${providerEventId}`)
    }

    const event = this.billingProvider.normalizeWebhookEvent(payload)

    // userId being null means the provider could not identify the user from the payload.
    // This is not a transient error — retrying will not fix it. Do not throw. Route to human review.
    if (event.userId === null) {
      await this.billingRepo.markUnresolvable(providerEventId)
      webhooksUnresolvableTotal.inc()
      this.logger.warn(
        { providerEventId, providerSubscriptionId: event.providerSubscriptionId },
        'billing.webhook.unresolvable: Investigate via provider dashboard'
      )
      return
    }

    try {
      switch (event.normalizedType) {
        case NormalizedEventType.SUBSCRIPTION_CREATED:
          await this.subscriptionService.upsert(event)
          break

        case NormalizedEventType.PAYMENT_SUCCESS:
          await this.subscriptionService.extendPeriod(event)
          await this.subscriptionService.clearGracePeriod(event.userId)
          break

        case NormalizedEventType.PAYMENT_FAILED:
          await this.subscriptionService.setGracePeriod(event.userId, 7) // 7 days grace period
          await this.queues.notificationsPush.add(
            'payment-failed',
            { userId: event.userId },
            { jobId: `payment-failed:${event.userId}:${Date.now()}` }
          )
          this.logger.info({ userId: event.userId, type: 'payment_failed' }, 'Payment failed. Notification queued.')
          break

        case NormalizedEventType.SUBSCRIPTION_CANCELLED:
          await this.subscriptionService.markCancelled(event)
          break

        case NormalizedEventType.CARD_EXPIRING_SOON:
          await this.queues.notificationsPush.add(
            'card-expiring',
            { userId: event.userId },
            { jobId: `card-expiring:${event.userId}:${Date.now()}` }
          )
          this.logger.info({ userId: event.userId, type: 'card_expiring' }, 'Card expiring. Notification queued.')
          break
      }

      await this.billingRepo.markProcessed(providerEventId)
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      await this.billingRepo.markFailed(providerEventId, errorMsg)
      this.logger.error({ err, providerEventId, userId: event.userId }, 'Failed to process billing webhook job')
      throw err
    }
  }
}
