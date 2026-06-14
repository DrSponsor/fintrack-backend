import type { OAuthService } from './oauth.service'
import type { IAccountRepository } from '../../../accounts/repositories/account.repo'
import { notFound } from '../../../../core/errors/factories'

export type DisconnectGmailUseCaseDeps = {
  readonly accountRepo: IAccountRepository
  readonly oauthService: OAuthService
}

export class DisconnectGmailUseCase {
  private readonly accountRepo: IAccountRepository
  private readonly oauthService: OAuthService

  public constructor(deps: DisconnectGmailUseCaseDeps) {
    this.accountRepo = deps.accountRepo
    this.oauthService = deps.oauthService
  }

  public async execute(userId: string, accountId: string): Promise<void> {
    const account = await this.accountRepo.findById(accountId)
    if (account === null || account.userId !== userId) {
      throw notFound('Account not found')
    }

    await this.oauthService.disconnect(accountId)
  }
}
