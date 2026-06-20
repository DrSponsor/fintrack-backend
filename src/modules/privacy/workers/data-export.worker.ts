import type { ConnectionOptions, Job } from 'bullmq'
import { BaseWorker } from '../../../core/queue/base-worker'
import { QUEUE_NAMES } from '../../../core/queue/queues'
import type { QueueRegistry } from '../../../core/queue/queues'
import type { IPrivacyRepository } from '../repositories/privacy.repo'
import type { IStorageProvider } from '../../../core/storage/local-storage.provider'
import type { AppLogger } from '../../../core/logger'

export type ExportJobData = {
  readonly userId: string
  readonly email: string
}

export type DataExportWorkerDeps = {
  readonly connection: ConnectionOptions
  readonly concurrency: number
  readonly privacyRepo: IPrivacyRepository
  readonly storageProvider: IStorageProvider
  readonly queues: QueueRegistry
  readonly logger: AppLogger
}

/**
 * Data Export Worker
 *
 * NDPR "Right to Data Portability" — generates a JSON export of all user data,
 * uploads it to storage, and dispatches an email with the download link.
 */
export class DataExportWorker extends BaseWorker<ExportJobData, void> {
  public constructor(deps: DataExportWorkerDeps) {
    super({
      queueName: QUEUE_NAMES.privacyExport,
      connection: deps.connection,
      concurrency: deps.concurrency,
      logger: deps.logger,
      processor: async (job: Job<ExportJobData>) => {
        const { userId, email } = job.data

        deps.logger.info({ userId, jobId: job.id }, 'Starting data export generation')

        // 1. Gather all user data
        const exportData = await deps.privacyRepo.getUserExportData(userId)
        if (!exportData) {
          deps.logger.warn({ userId }, 'User not found — cannot generate export')
          return
        }

        // 2. Serialize to JSON
        const exportPayload = {
          exportedAt: new Date().toISOString(),
          exportVersion: '1.0',
          platform: 'FinTrack',
          ...exportData,
        }

        const jsonBuffer = Buffer.from(JSON.stringify(exportPayload, null, 2), 'utf-8')
        const sizeKb = (jsonBuffer.byteLength / 1024).toFixed(2)

        deps.logger.info(
          { userId, sizeKb, transactionCount: exportData.transactions.length },
          'Export data gathered and serialized'
        )

        // 3. Upload to storage (local disk in dev, R2 in production)
        const storageKey = `exports/${userId}/${Date.now()}-fintrack-export.json`
        const uploadResult = await deps.storageProvider.upload(
          storageKey,
          jsonBuffer,
          'application/json'
        )

        deps.logger.info(
          { userId, key: uploadResult.key, expiresAt: uploadResult.expiresAt.toISOString() },
          'Export uploaded to storage'
        )

        // 4. Dispatch email notification with the download link
        // We reuse the notifications queue to send the email via the existing
        // notification infrastructure. We add a special job name for this.
        await deps.queues.notificationsPush.add(
          'data-export-ready',
          {
            userId,
            email,
            downloadUrl: uploadResult.downloadUrl,
            expiresAt: uploadResult.expiresAt.toISOString(),
          },
          { jobId: `export-ready-${userId}-${Date.now()}` }
        )

        deps.logger.info({ userId, email }, 'Data export completed and notification queued')
      },
    })
  }
}
