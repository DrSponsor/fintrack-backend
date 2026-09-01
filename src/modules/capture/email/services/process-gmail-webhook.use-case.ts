import type { Queue } from 'bullmq'
import { jobId } from '../../../../core/queue/job-id'
import type { IGmailConnectionRepository } from '../repositories/gmail-connection.repo'
import type { AppLogger } from '../../../../core/logger'

/**
 * Turns a Gmail push notification into work.
 *
 * ── What this replaced ───────────────────────────────────────────────────
 * The previous version looked the user up by `User.email`, then queued one job
 * per Gmail-connected ACCOUNT:
 *
 *     for (const user of users)
 *       for (const account of user.accounts)
 *         queue.add('sync-history', { accountId: account.id, historyId })
 *
 * Two defects, both invisible with a single account.
 *
 * THE FAN-OUT. One notification about one inbox became N jobs, each fetching
 * and parsing the same messages. Gmail quota, AI parser calls and database work
 * all multiplied by the number of accounts, and the surplus rows were then
 * discarded by deduplication — so the cost was paid to produce nothing. Worse,
 * every job carried a DIFFERENT accountId for the same email, and whichever
 * worker finished first decided which account the money landed on.
 *
 * THE ADDRESS ASSUMPTION. Matching on `User.email` assumes the address someone
 * signed up with is the mailbox they connected. Anyone who connected a
 * different Gmail got no notifications at all, silently — their capture simply
 * never fired and nothing reported it.
 *
 * Now one notification is one job, addressed to the connection, and the
 * account each alert belongs to is decided by the alert itself.
 */

export type ProcessGmailWebhookUseCaseDeps = {
  readonly connectionRepo: IGmailConnectionRepository
  readonly captureEmailQueue: Queue
  readonly logger: AppLogger
}

export class ProcessGmailWebhookUseCase {
  private readonly connectionRepo: IGmailConnectionRepository
  private readonly queue: Queue
  private readonly logger: AppLogger

  public constructor(deps: ProcessGmailWebhookUseCaseDeps) {
    this.connectionRepo = deps.connectionRepo
    this.queue = deps.captureEmailQueue
    this.logger = deps.logger
  }

  /** Returns how many jobs were queued, which the route reports to Google. */
  public async execute(emailAddress: string, historyId: string): Promise<number> {
    const connections = await this.connectionRepo.findByEmailAddress(emailAddress)

    if (connections.length === 0) {
      // Not an error worth failing the request over — Google retries, and a
      // notification for a disconnected mailbox is expected during the window
      // between a user disconnecting and the watch lapsing. Logged because a
      // steady stream of these means watches are outliving their connections.
      this.logger.info(
        { historyId },
        'Gmail notification for an address with no live connection; nothing queued',
      )
      return 0
    }

    let queued = 0
    for (const connection of connections) {
      await this.queue.add(
        'sync-history',
        { userId: connection.userId, historyId },
        // Google delivers the same notification more than once by design. The
        // id makes a redelivery a no-op rather than a second full sync.
        { jobId: jobId('sync-history', connection.userId, historyId) },
      )
      queued++
    }
    return queued
  }
}
