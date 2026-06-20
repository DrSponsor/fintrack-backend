import type { ConnectionOptions, Job } from 'bullmq'
import { BaseWorker } from '../../../core/queue/base-worker'
import { QUEUE_NAMES } from '../../../core/queue/queues'
import type { NotificationService } from '../services/notification.service'
import type { AppLogger } from '../../../core/logger'

export type NotificationJobData = {
  readonly userId: string
  readonly budgetId?: string
  readonly categoryId?: string
  readonly spentKobo?: string | number
  readonly limitKobo?: string | number
  readonly email?: string
}

export type NotificationWorkerDeps = {
  readonly connection: ConnectionOptions
  readonly concurrency: number
  readonly notificationService: NotificationService
  readonly logger: AppLogger
}

export class NotificationWorker extends BaseWorker<NotificationJobData, void> {
  public constructor(deps: NotificationWorkerDeps) {
    super({
      queueName: QUEUE_NAMES.notificationsPush,
      connection: deps.connection,
      concurrency: deps.concurrency,
      logger: deps.logger,
      processor: async (job: Job<NotificationJobData>) => {
        const { userId } = job.data
        deps.logger.info(
          { jobId: job.id, jobName: job.name, userId },
          'Processing notification job'
        )

        switch (job.name) {
          case 'budget-limit-exceeded': {
            const { budgetId, categoryId, spentKobo, limitKobo } = job.data
            if (!budgetId || !categoryId || spentKobo === undefined || limitKobo === undefined) {
              throw new Error(`Invalid job data for budget-limit-exceeded: ${JSON.stringify(job.data)}`)
            }
            await deps.notificationService.sendBudgetAlert(
              userId,
              budgetId,
              categoryId,
              BigInt(spentKobo),
              BigInt(limitKobo)
            )
            break
          }
          case 'payment-failed': {
            await deps.notificationService.sendPaymentFailed(userId)
            break
          }
          case 'card-expiring': {
            await deps.notificationService.sendCardExpiring(userId)
            break
          }
          case 'subscription-expired': {
            await deps.notificationService.sendSubscriptionExpired(userId)
            break
          }
          case 'data-deletion-confirmation': {
            const { email } = job.data
            if (!email) {
              throw new Error(`Invalid job data for data-deletion-confirmation: ${JSON.stringify(job.data)}`)
            }
            await deps.notificationService.sendDataDeletionConfirmation(userId, email)
            break
          }
          case 'data-export-ready': {
            const { email, downloadUrl, expiresAt } = job.data as NotificationJobData & {
              readonly downloadUrl?: string
              readonly expiresAt?: string
            }
            if (!email || !downloadUrl || !expiresAt) {
              throw new Error(`Invalid job data for data-export-ready: ${JSON.stringify(job.data)}`)
            }
            await deps.notificationService.sendDataExportReady(userId, email, downloadUrl, expiresAt)
            break
          }
          default: {
            deps.logger.warn({ jobName: job.name }, 'Unknown notification job name received')
            throw new Error(`Unknown job name: ${job.name}`)
          }
        }
      },
    })
  }
}
