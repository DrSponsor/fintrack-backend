import type { ConnectionOptions, Job } from 'bullmq'
import { BaseWorker } from '../../../../core/queue/base-worker'
import { QUEUE_NAMES } from '../../../../core/queue/queues'
import type { PrismaClient } from '../../../../generated/prisma/client'
import type { IGmailConnectionRepository } from '../repositories/gmail-connection.repo'
import type { OAuthService } from '../services/oauth.service'
import type { WatchService } from '../services/watch.service'
import type { AppLogger } from '../../../../core/logger'

export type WatchRenewalWorkerDeps = {
  readonly connection: ConnectionOptions
  readonly concurrency: number
  readonly prisma: PrismaClient
  readonly connectionRepo: IGmailConnectionRepository
  readonly oauthService: OAuthService
  readonly watchService: WatchService
  readonly logger: AppLogger
}

export class WatchRenewalWorker extends BaseWorker<void, void> {
  private readonly prisma: PrismaClient
  private readonly connectionRepo: IGmailConnectionRepository
  private readonly oauthService: OAuthService
  private readonly watchService: WatchService
  private readonly logger: AppLogger

  public constructor(deps: WatchRenewalWorkerDeps) {
    super({
      queueName: QUEUE_NAMES.watchRenewal,
      connection: deps.connection,
      concurrency: deps.concurrency,
      logger: deps.logger,
      processor: (job) => this.processJob(job),
    })

    this.prisma = deps.prisma
    this.connectionRepo = deps.connectionRepo
    this.oauthService = deps.oauthService
    this.watchService = deps.watchService
    this.logger = deps.logger
  }

  private async processJob(_job: Job<void, void, string>): Promise<void> {
    this.logger.info('Starting Gmail watch renewal cycle for all active connected mailboxes')
    await this.renewAllWatches()
  }

  /**
   * Renews the watches that are actually near lapsing.
   *
   * Two things were wrong before. It renewed EVERY connected account on every
   * cycle, so a user with three accounts on one mailbox re-registered the same
   * watch three times against a Google quota. And it addressed the watch to
   * User.email — the signup address — rather than the mailbox actually
   * authorised, so anyone who connected a different Gmail had their watch
   * registered against an address they had never granted access to.
   *
   * Now: one row per inbox, only those expiring, addressed to the mailbox
   * Google named.
   */
  public async renewAllWatches(): Promise<void> {
    // A day of headroom. Gmail watches last seven days and this runs daily, so
    // renewing a day early means a missed cycle is survivable rather than a
    // silent gap in capture.
    const renewBefore = new Date(Date.now() + 24 * 60 * 60 * 1000)
    const due = await this.connectionRepo.findExpiringWatches(renewBefore)
    this.logger.info({ count: due.length }, 'Gmail watches due for renewal')

    // Concurrency control helper (limit to 5 parallel requests)
    const limit = 5
    const tasks = due.map((gmail): (() => Promise<void>) => async () => {
      try {
        const accessToken = await this.oauthService.getValidAccessToken(gmail.userId)
        const watch = await this.watchService.setUpWatch(gmail.emailAddress, accessToken)
        await this.connectionRepo.saveWatch(
          gmail.userId,
          watch.historyId,
          new Date(Number(watch.expiration)),
        )

        this.logger.info({ userId: gmail.userId }, 'Gmail watch renewed')
      } catch (err) {
        this.logger.error({ userId: gmail.userId, err }, 'Failed to renew Gmail watch')
      }
    })

    await this.limitConcurrency(tasks, limit)
    this.logger.info('Completed Gmail watch renewal cycle')
  }

  private async limitConcurrency(tasks: readonly (() => Promise<void>)[], limit: number): Promise<void> {
    const results: Promise<void>[] = []
    const executing = new Set<Promise<void>>()

    for (const task of tasks) {
      const p = Promise.resolve().then(() => task())
      results.push(p)
      executing.add(p)

      const clean = (): void => {
        executing.delete(p)
      }
      p.then(clean, clean)

      if (executing.size >= limit) {
        await Promise.race(executing)
      }
    }

    await Promise.allSettled(results)
  }
}
