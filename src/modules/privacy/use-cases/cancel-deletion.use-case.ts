import type { IPrivacyRepository } from '../repositories/privacy.repo'
import type { QueueRegistry } from '../../../core/queue/queues'
import type { AppLogger } from '../../../core/logger'
import { conflict } from '../../../core/errors/factories'

export type CancelDeletionResult = {
  readonly message: string
}

export class CancelDeletionUseCase {
  private readonly privacyRepo: IPrivacyRepository
  private readonly queues: QueueRegistry
  private readonly logger: AppLogger

  public constructor(deps: {
    readonly privacyRepo: IPrivacyRepository
    readonly queues: QueueRegistry
    readonly logger: AppLogger
  }) {
    this.privacyRepo = deps.privacyRepo
    this.queues = deps.queues
    this.logger = deps.logger
  }

  public async execute(userId: string): Promise<CancelDeletionResult> {
    // Check if there is a pending deletion
    const scheduledAt = await this.privacyRepo.getDeletionScheduledAt(userId)
    if (scheduledAt === null) {
      throw conflict('No pending deletion request found for this account')
    }

    // Abort: clear the scheduled deletion timestamp
    await this.privacyRepo.cancelDeletion(userId)

    // Remove the queued BullMQ job (best-effort — if the job already ran, it's too late)
    const jobId = `deletion-${userId}`
    const job = await this.queues.privacyDeletion.getJob(jobId)
    if (job) {
      await job.remove()
      this.logger.info({ userId, jobId }, 'Deletion job removed from queue')
    } else {
      this.logger.warn(
        { userId, jobId },
        'Deletion job not found in queue — may have already been processed'
      )
    }

    this.logger.info({ userId }, 'Account deletion cancelled by user')

    return {
      message: 'Your account deletion request has been cancelled. Your data is safe.',
    }
  }
}
