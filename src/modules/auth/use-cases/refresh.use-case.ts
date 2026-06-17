import type { AppLogger } from '../../../core/logger'
import type { IUserRepository } from '../repositories/user.repo'
import type { ISessionRepository } from '../repositories/session.repo'
import { signAccessToken } from '../../../core/crypto/tokens'
import type { AccessTokenPayload } from '../../../core/crypto/tokens'
import { unauthenticated, tokenRevoked } from '../../../core/errors/factories'

// ──────────────────────────────────────────────────────────────────
// Result type
// ──────────────────────────────────────────────────────────────────

export type RefreshResult = {
  readonly accessToken: string
  readonly refreshToken: string
  readonly sessionId: string
  readonly expiresIn: number
}

// ──────────────────────────────────────────────────────────────────
// Use case
// ──────────────────────────────────────────────────────────────────

export type RefreshUseCaseDeps = {
  readonly userRepo: IUserRepository
  readonly sessionRepo: ISessionRepository
  readonly jwtPrivateKeyPem: string
  readonly logger: AppLogger
}

/**
 * Rotate a refresh token and issue a new token pair.
 *
 * Architecture requirement:
 *   - Refresh tokens are one-time use, rotating.
 *   - Stolen refresh token used after legitimate rotation
 *     → ALL sessions for that user immediately revoked.
 *
 * Flow:
 *   1. Validate input (sessionId from token payload, refreshToken from body)
 *   2. Rotate: consume old token, issue new token in the same operation
 *      - If old token is invalid → return 401
 *      - If old token was already consumed (reuse detected) → revoke ALL
 *        sessions, return 401
 *   3. Look up user for fresh JWT claims (tier may have changed)
 *   4. Sign new access token
 *   5. Return new token pair
 */
export class RefreshUseCase {
  private readonly userRepo: IUserRepository
  private readonly sessionRepo: ISessionRepository
  private readonly jwtPrivateKeyPem: string
  private readonly logger: AppLogger

  public constructor(deps: RefreshUseCaseDeps) {
    this.userRepo = deps.userRepo
    this.sessionRepo = deps.sessionRepo
    this.jwtPrivateKeyPem = deps.jwtPrivateKeyPem
    this.logger = deps.logger
  }

  public async execute(
    userId: string,
    sessionId: string,
    refreshToken: string,
  ): Promise<RefreshResult> {
    // Rotate: consume old, issue new. Null = invalid or reuse detected.
    const newSession = await this.sessionRepo.rotate(userId, sessionId, refreshToken)
    if (newSession === null) {
      this.logger.warn({ userId }, 'refresh token invalid or reuse detected — sessions may be revoked')
      throw tokenRevoked('Refresh token is invalid or has been revoked')
    }

    // Fetch fresh user data for updated JWT claims (tier may have changed
    // between the original access token issue and this refresh).
    const user = await this.userRepo.findById(userId)
    if (user === null) {
      // User was deleted between token issue and refresh. Clean up.
      await this.sessionRepo.revokeAll(userId)
      throw unauthenticated('User account no longer exists')
    }

    const tokenPayload: AccessTokenPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      tier: user.tier,
    }

    const accessToken = await signAccessToken(tokenPayload, this.jwtPrivateKeyPem)

    this.logger.info({ userId, sessionId: newSession.sessionId }, 'token refreshed')

    return {
      accessToken,
      refreshToken: newSession.refreshToken,
      sessionId: newSession.sessionId,
      expiresIn: 900,
    }
  }
}
