import type { ConnectionOptions, Job } from 'bullmq'
import { BaseWorker } from '../../../../core/queue/base-worker'
import { QUEUE_NAMES } from '../../../../core/queue/queues'
import type { PrismaClient } from '../../../../generated/prisma/client'
import type { IAccountRepository } from '../../../accounts/repositories/account.repo'
import type { OAuthService } from '../services/oauth.service'
import type { WatchService } from '../services/watch.service'
import type { AppLogger } from '../../../../core/logger'

export type WatchRenewalWorkerDeps = {
  readonly connection: ConnectionOptions
  readonly concurrency: number
  readonly prisma: PrismaClient
  readonly accountRepo: IAccountRepository
  readonly oauthService: OAuthService
  readonly watchService: WatchService
  readonly logger: AppLogger
}

export class WatchRenewalWorker extends BaseWorker<void, void> {
  private readonly prisma: PrismaClient
  private readonly accountRepo: IAccountRepository
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
    this.accountRepo = deps.accountRepo
    this.oauthService = deps.oauthService
    this.watchService = deps.watchService
    this.logger = deps.logger
  }

  private async processJob(_job: Job<void, void, string>): Promise<void> {
    this.logger.info('Starting Gmail watch renewal cycle for all active connected mailboxes')
    await this.renewAllWatches()
  }

  public async renewAllWatches(): Promise<void> {
    const connectedAccounts = await this.accountRepo.findConnectedGmailAccounts()
    this.logger.info({ count: connectedAccounts.length }, 'Found active connected Gmail accounts to renew')

    // Concurrency control helper (limit to 5 parallel requests)
    const limit = 5
    const tasks = connectedAccounts.map((account) => async () => {
      try {
        const user = await this.prisma.user.findUnique({
          where: { id: account.userId },
          select: { email: true },
        })
        const email = user?.email ?? 'unknown@fintrack.com'

        const accessToken = await this.oauthService.getValidAccessToken(account.id)
        await this.watchService.setUpWatch(email, accessToken)

        this.logger.info(
          { accountId: account.id, email },
          'Gmail watch successfully renewed for account',
        )
      } catch (err) {
        this.logger.error(
          { accountId: account.id, err },
          'Failed to renew Gmail watch for account during batch cycle',
        )
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

      const clean = () => {
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
