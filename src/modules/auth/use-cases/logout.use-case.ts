import type { AppLogger } from '../../../core/logger'
import type { ISessionRepository } from '../repositories/session.repo'

// ──────────────────────────────────────────────────────────────────
// Use case
// ──────────────────────────────────────────────────────────────────

export type LogoutUseCaseDeps = {
  readonly sessionRepo: ISessionRepository
  readonly logger: AppLogger
}

/**
 * Logout: revoke the current session.
 *
 * This revokes a single session (single device logout).
 * For "logout everywhere", call sessionRepo.revokeAll directly
 * (exposed via a separate endpoint if needed).
 */
export class LogoutUseCase {
  private readonly sessionRepo: ISessionRepository
  private readonly logger: AppLogger

  public constructor(deps: LogoutUseCaseDeps) {
    this.sessionRepo = deps.sessionRepo
    this.logger = deps.logger
  }

  public async execute(userId: string, sessionId: string): Promise<void> {
    await this.sessionRepo.revoke(userId, sessionId)
    this.logger.info({ userId, sessionId }, 'user logged out')
  }
}
