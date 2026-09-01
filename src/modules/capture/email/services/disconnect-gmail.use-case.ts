import type { OAuthService } from './oauth.service'

/**
 * Disconnects a person's inbox.
 *
 * One operation now, whatever the account count. It used to verify an account
 * belonged to the caller and clear that account's token, so a user with three
 * accounts on one Gmail had to disconnect three times — and any of those
 * writes could fail, leaving a live refresh token behind on an account the
 * user believed was disconnected.
 *
 * There is no ownership check because there is nothing to check: the
 * connection is keyed by the authenticated user's own id, so a caller can only
 * ever disconnect themselves. Revocation with Google is attempted inside
 * OAuthService and is best-effort, but the row goes either way — a user who
 * asks to disconnect must not stay connected because Google was unreachable.
 */
export type DisconnectGmailUseCaseDeps = {
  readonly oauthService: OAuthService
}

export class DisconnectGmailUseCase {
  private readonly oauthService: OAuthService

  public constructor(deps: DisconnectGmailUseCaseDeps) {
    this.oauthService = deps.oauthService
  }

  public async execute(userId: string): Promise<void> {
    await this.oauthService.disconnect(userId)
  }
}
