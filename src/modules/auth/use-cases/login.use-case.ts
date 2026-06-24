import type { AppLogger } from '../../../core/logger'
import type { IUserRepository } from '../repositories/user.repo'
import type { ISessionRepository } from '../repositories/session.repo'
import { verifyPassword } from '../../../core/crypto/hashing'
import { signAccessToken } from '../../../core/crypto/tokens'
import type { AccessTokenPayload } from '../../../core/crypto/tokens'
import { invalidCredentials } from '../../../core/errors/factories'
import { loginBodySchema } from '../schemas/auth.schemas'

// ──────────────────────────────────────────────────────────────────
// Result type
// ──────────────────────────────────────────────────────────────────

export type LoginResult = {
  readonly accessToken: string
  readonly refreshToken: string
  readonly sessionId: string
  readonly expiresIn: number
}

// ──────────────────────────────────────────────────────────────────
// Use case
// ──────────────────────────────────────────────────────────────────

export type LoginUseCaseDeps = {
  readonly userRepo: IUserRepository
  readonly sessionRepo: ISessionRepository
  readonly jwtPrivateKeyPem: string
  readonly logger: AppLogger
}

/**
 * Authenticate a user with email + password.
 *
 * Flow:
 *   1. Validate input
 *   2. Find user by email — if not found, return INVALID_CREDENTIALS
 *      (never reveal whether the email exists via different error codes)
 *   3. Verify password with Argon2id — if wrong, return INVALID_CREDENTIALS
 *   4. Create session (refresh token issued)
 *   5. Sign access token
 *   6. Return token pair
 *
 * Security: same error message for "user not found" and "wrong password"
 * to prevent email enumeration.
 */
export class LoginUseCase {
  private readonly userRepo: IUserRepository
  private readonly sessionRepo: ISessionRepository
  private readonly jwtPrivateKeyPem: string
  private readonly logger: AppLogger

  public constructor(deps: LoginUseCaseDeps) {
    this.userRepo = deps.userRepo
    this.sessionRepo = deps.sessionRepo
    this.jwtPrivateKeyPem = deps.jwtPrivateKeyPem
    this.logger = deps.logger
  }

  public async execute(rawBody: unknown): Promise<LoginResult> {
    const parsed = loginBodySchema.parse(rawBody)
    const { email, password } = parsed

    const user = await this.userRepo.findByEmail(email)
    if (user === null) {
      // Do NOT reveal that the email doesn't exist.
      // Hash a dummy value to prevent timing attacks (password verification
      // takes ~300ms with Argon2id; returning instantly reveals the email
      // doesn't exist).
      await verifyPassword('$argon2id$v=19$m=65536,t=3,p=1$dummy$dummy', password).catch(() => {})
      throw invalidCredentials()
    }

    if (user.passwordHash === null) {
      // User has no password (e.g. registered via Google).
      // Hash a dummy value to prevent timing attacks.
      await verifyPassword('$argon2id$v=19$m=65536,t=3,p=1$dummy$dummy', password).catch(() => {})
      throw invalidCredentials()
    }

    const passwordValid = await verifyPassword(user.passwordHash, password)
    if (!passwordValid) {
      throw invalidCredentials()
    }

    this.logger.info({ userId: user.id }, 'user logged in')

    const session = await this.sessionRepo.create(user.id)

    const tokenPayload: AccessTokenPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      tier: user.tier,
      sid: session.sessionId,
    }

    const accessToken = await signAccessToken(tokenPayload, this.jwtPrivateKeyPem)

    return {
      accessToken,
      refreshToken: session.refreshToken,
      sessionId: session.sessionId,
      expiresIn: 900,
    }
  }
}
