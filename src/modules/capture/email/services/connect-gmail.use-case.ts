import type { OAuthService } from './oauth.service'
import type { WatchService } from './watch.service'
import type { IAccountRepository } from '../../../accounts/repositories/account.repo'
import type { Queue } from 'bullmq'
import { notFound } from '../../../../core/errors/factories'

export type ConnectGmailUseCaseDeps = {
  readonly accountRepo: IAccountRepository
  readonly oauthService: OAuthService
  readonly watchService: WatchService
  readonly captureEmailQueue: Queue
}

export class ConnectGmailUseCase {
  private readonly accountRepo: IAccountRepository
  private readonly oauthService: OAuthService
  private readonly watchService: WatchService
  private readonly captureEmailQueue: Queue

  public constructor(deps: ConnectGmailUseCaseDeps) {
    this.accountRepo = deps.accountRepo
    this.oauthService = deps.oauthService
    this.watchService = deps.watchService
    this.captureEmailQueue = deps.captureEmailQueue
  }

  public async execute(userId: string, accountId: string, code: string): Promise<{ readonly email: string }> {
    const account = await this.accountRepo.findById(accountId)
    if (account === null || account.userId !== userId) {
      throw notFound('Account not found')
    }

    const { email } = await this.oauthService.exchangeCodeAndSave(accountId, code)
    const accessToken = await this.oauthService.getValidAccessToken(accountId)
    await this.watchService.setUpWatch(email, accessToken)

    await this.captureEmailQueue.add(
      'sync-history',
      { accountId, historyId: '0' },
      { jobId: `sync-history-initial:${accountId}` },
    )

    return { email }
  }
}
