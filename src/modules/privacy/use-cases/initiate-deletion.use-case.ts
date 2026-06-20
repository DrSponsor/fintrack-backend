import type { IPrivacyRepository } from '../repositories/privacy.repo'
import type { QueueRegistry } from '../../../core/queue/queues'
import type { AppLogger } from '../../../core/logger'
import { deletionPending } from '../../../core/errors/factories'

const COOLING_OFF_HOURS = 24

export type InitiateDeletionResult = {
  readonly scheduledAt: Date
  readonly message: string
}

export class InitiateDeletionUseCase {
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

  public async execute(userId: string): Promise<InitiateDeletionResult> {
    // Guard: Check if deletion is already scheduled
    const existingSchedule = await this.privacyRepo.getDeletionScheduledAt(userId)
    if (existingSchedule !== null) {
      throw deletionPending(
        `Account deletion is already scheduled for ${existingSchedule.toISOString()}. ` +
        `Use the cancel-deletion endpoint to abort.`
      )
    }

    // Schedule deletion 24 hours from now
    const scheduledAt = new Date(Date.now() + COOLING_OFF_HOURS * 60 * 60 * 1_000)
    await this.privacyRepo.scheduleDeletion(userId, scheduledAt)

    // Queue the deletion job with a 24-hour delay
    const delayMs = COOLING_OFF_HOURS * 60 * 60 * 1_000
    await this.queues.privacyDeletion.add(
      'execute-deletion',
      { userId },
      {
        jobId: `deletion-${userId}`,
        delay: delayMs,
      }
    )

    this.logger.info(
      { userId, scheduledAt: scheduledAt.toISOString(), delayMs },
      'Account deletion initiated with cooling-off period'
    )

    return {
      scheduledAt,
      message: `Your account and all data will be permanently deleted after ${scheduledAt.toISOString()}. ` +
        `You can cancel this request within the next ${COOLING_OFF_HOURS} hours.`,
    }
  }
}
