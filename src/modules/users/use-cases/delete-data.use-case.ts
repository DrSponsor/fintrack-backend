import type { Redis } from 'ioredis'
import type { AppLogger } from '../../../core/logger'
import type { IUserProfileRepository } from '../repositories/user-profile.repo'
import type { ISessionRepository } from '../../auth/repositories/session.repo'
import { notFound, conflict } from '../../../core/errors/factories'

// ──────────────────────────────────────────────────────────────────
// NDPR Data Deletion Use Case
//
// Architecture spec: 24-hour cooling-off period before deletion.
// The user can cancel the deletion within the cooling-off window.
//
// Flow:
//   1. Check no deletion is already scheduled (Redis key)
//   2. Schedule deletion: set Redis key with 24h TTL
//   3. Return confirmation with scheduled time
//
// The actual deletion is executed by a scheduled worker that polls
// for expired cooling-off keys. This use case only SCHEDULES it.
//
// When the worker fires:
//   - Delete all user data (NDPR compliance)
//   - Revoke all sessions
//   - No recovery possible after this point
// ──────────────────────────────────────────────────────────────────

const COOLING_OFF_SECONDS = 24 * 60 * 60 // 24 hours

function deletionScheduleKey(userId: string): string {
  return `deletion-schedule:${userId}`
}

export type DeleteDataUseCaseDeps = {
  readonly userProfileRepo: IUserProfileRepository
  readonly sessionRepo: ISessionRepository
  readonly redis: Redis
  readonly logger: AppLogger
}

export type DeleteDataResult = {
  readonly message: string
  readonly scheduledDeletionAt: string
}

export class DeleteDataUseCase {
  private readonly userProfileRepo: IUserProfileRepository
  private readonly sessionRepo: ISessionRepository
  private readonly redis: Redis
  private readonly logger: AppLogger

  public constructor(deps: DeleteDataUseCaseDeps) {
    this.userProfileRepo = deps.userProfileRepo
    this.sessionRepo = deps.sessionRepo
    this.redis = deps.redis
    this.logger = deps.logger
  }

  public async execute(userId: string): Promise<DeleteDataResult> {
    // Verify user exists
    const user = await this.userProfileRepo.findById(userId)
    if (user === null) {
      throw notFound('User not found')
    }

    // Check if deletion is already scheduled (idempotency)
    const existingSchedule = await this.redis.get(deletionScheduleKey(userId))
    if (existingSchedule !== null) {
      throw conflict('Data deletion is already scheduled. Cancel the existing request first.')
    }

    // Schedule deletion with 24h cooling-off
    const scheduledAt = new Date(Date.now() + COOLING_OFF_SECONDS * 1000)
    await this.redis.set(
      deletionScheduleKey(userId),
      JSON.stringify({ userId, scheduledAt: scheduledAt.toISOString() }),
      'EX',
      COOLING_OFF_SECONDS,
    )

    this.logger.info(
      { userId, scheduledDeletionAt: scheduledAt.toISOString() },
      'NDPR data deletion scheduled',
    )

    return {
      message: 'Your data deletion has been scheduled. You have 24 hours to cancel this request.',
      scheduledDeletionAt: scheduledAt.toISOString(),
    }
  }

  /**
   * Cancel a scheduled deletion (within cooling-off window).
   */
  public async cancel(userId: string): Promise<void> {
    const deleted = await this.redis.del(deletionScheduleKey(userId))
    if (deleted === 0) {
      throw notFound('No pending deletion request found')
    }
    this.logger.info({ userId }, 'NDPR data deletion cancelled')
  }

  /**
   * Execute the actual deletion (called by the scheduled worker ONLY).
   * This is the irreversible operation.
   */
  public async executeImmediateDeletion(userId: string): Promise<void> {
    this.logger.warn({ userId }, 'executing irreversible NDPR data deletion')

    // Revoke all sessions first (prevent any concurrent access)
    await this.sessionRepo.revokeAll(userId)

    // Delete all user data from database
    await this.userProfileRepo.deleteAllData(userId)

    // Clean up Redis schedule key
    await this.redis.del(deletionScheduleKey(userId))

    this.logger.warn({ userId }, 'NDPR data deletion completed — user data permanently removed')
  }
}
