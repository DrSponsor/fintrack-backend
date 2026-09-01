import type { OAuthService } from './oauth.service'
import type { WatchService } from './watch.service'
import type { IGmailConnectionRepository } from '../repositories/gmail-connection.repo'
import type { Queue } from 'bullmq'
import { jobId } from '../../../../core/queue/job-id'
import type { AppLogger } from '../../../../core/logger'

/**
 * Connects a person's inbox.
 *
 * ── What changed, and why it matters more than it looks ──────────────────
 * This used to take an accountId, verify the account belonged to the caller,
 * and store the token against it. So an account had to EXIST before its inbox
 * could be connected — which meant the very first thing a new user did was
 * type a bank name and four digits that the app had no way to check.
 *
 * That ordering is backwards. The inbox is what the app can read; the accounts
 * are what it finds INSIDE the inbox. Connecting first and discovering second
 * means the user confirms account numbers the bank itself printed, rather than
 * typing ones nobody verifies.
 *
 * It also removes a duplicate-token problem that was invisible with one
 * account: three accounts alerting to one Gmail stored the same refresh token
 * three times, and disconnecting was three writes any of which could fail and
 * leave a live token behind.
 */

export type ConnectGmailUseCaseDeps = {
  readonly connectionRepo: IGmailConnectionRepository
  readonly oauthService: OAuthService
  readonly watchService: WatchService
  readonly captureEmailQueue: Queue
  readonly logger: AppLogger
}

export class ConnectGmailUseCase {
  private readonly connectionRepo: IGmailConnectionRepository
  private readonly oauthService: OAuthService
  private readonly watchService: WatchService
  private readonly captureEmailQueue: Queue
  private readonly logger: AppLogger

  public constructor(deps: ConnectGmailUseCaseDeps) {
    this.connectionRepo = deps.connectionRepo
    this.oauthService = deps.oauthService
    this.watchService = deps.watchService
    this.captureEmailQueue = deps.captureEmailQueue
    this.logger = deps.logger
  }

  /** No accountId. That is the point — see the header. */
  public async execute(userId: string, code: string): Promise<{ readonly email: string }> {
    const { email } = await this.oauthService.exchangeCodeAndSave(userId, code)
    const accessToken = await this.oauthService.getValidAccessToken(userId)

    // The watch is what makes capture live rather than polled. Its failure is
    // not fatal to connecting: the mailbox is authorised either way, the
    // initial backfill below still runs, and the renewal worker picks up any
    // connection without a live watch. Failing the whole connect here would
    // send the user back to Google's consent screen for a problem that fixes
    // itself within the hour.
    try {
      const watch = await this.watchService.setUpWatch(email, accessToken)
      // Previously discarded. There was nowhere to put it when the connection
      // lived on an account, so every renewal cycle re-derived what Google had
      // already told us.
      await this.connectionRepo.saveWatch(userId, watch.historyId, new Date(Number(watch.expiration)))
    } catch (err) {
      this.logger.warn({ err, userId }, 'Gmail watch setup failed; connection stands and renewal will retry')
    }

    // historyId '0' means "no cursor yet", which the sync reads as a first-run
    // backfill rather than an incremental catch-up.
    await this.captureEmailQueue.add(
      'sync-history',
      { userId, historyId: '0' },
      { jobId: jobId('sync-history-initial', userId) },
    )

    return { email }
  }
}
