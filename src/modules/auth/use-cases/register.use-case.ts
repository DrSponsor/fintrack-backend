import type { AppLogger } from '../../../core/logger'
import type { IUserRepository } from '../repositories/user.repo'
import type { ISessionRepository } from '../repositories/session.repo'
import { hashPassword } from '../../../core/crypto/hashing'
import { signAccessToken } from '../../../core/crypto/tokens'
import type { AccessTokenPayload } from '../../../core/crypto/tokens'
import { duplicateEmail, validationError } from '../../../core/errors/factories'
import { registerBodySchema } from '../schemas/auth.schemas'

// ──────────────────────────────────────────────────────────────────
// Result type
// ──────────────────────────────────────────────────────────────────

export type RegisterResult = {
  readonly userId: string
  readonly accessToken: string
  readonly refreshToken: string
  readonly sessionId: string
  readonly expiresIn: number
}

// ──────────────────────────────────────────────────────────────────
// Use case
// ──────────────────────────────────────────────────────────────────

export type RegisterUseCaseDeps = {
  readonly userRepo: IUserRepository
  readonly sessionRepo: ISessionRepository
  readonly jwtPrivateKeyPem: string
  readonly logger: AppLogger
}

/**
 * Register a new user.
 *
 * Flow:
 *   1. Validate input (Zod schema — password complexity enforced)
 *   2. Hash password with Argon2id
 *   3. Create user record (unique email enforced by DB)
 *   4. Create session (refresh token issued)
 *   5. Sign access token (JWT RS256, 15-minute expiry)
 *   6. Return token pair
 *
 * Idempotency: duplicate email → AppError DUPLICATE_EMAIL (409)
 *   Uses insert-then-catch pattern — the unique constraint on email
 *   is the atomic guard. No check-then-insert.
 */
export class RegisterUseCase {
  private readonly userRepo: IUserRepository
  private readonly sessionRepo: ISessionRepository
  private readonly jwtPrivateKeyPem: string
  private readonly logger: AppLogger

  public constructor(deps: RegisterUseCaseDeps) {
    this.userRepo = deps.userRepo
    this.sessionRepo = deps.sessionRepo
    this.jwtPrivateKeyPem = deps.jwtPrivateKeyPem
    this.logger = deps.logger
  }

  public async execute(rawBody: unknown): Promise<RegisterResult> {
    const parsed = registerBodySchema.safeParse(rawBody)
    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0]
      throw validationError(
        firstIssue?.message ?? 'Validation failed',
        firstIssue?.path[0] !== undefined ? String(firstIssue.path[0]) : undefined,
      )
    }

    const { email, password } = parsed.data
    const passwordHash = await hashPassword(password)

    // Insert-then-catch — Law 8 (TOCTOU).
    // Two concurrent registrations with the same email: only one succeeds.
    // The other hits the unique constraint and receives DUPLICATE_EMAIL.
    let user
    try {
      user = await this.userRepo.create({ email, passwordHash })
    } catch (error: unknown) {
      if (isUniqueConstraintError(error)) {
        throw duplicateEmail()
      }
      throw error
    }

    this.logger.info({ userId: user.id }, 'user registered')

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
      userId: user.id,
      accessToken,
      refreshToken: session.refreshToken,
      sessionId: session.sessionId,
      expiresIn: 900, // 15 minutes in seconds
    }
  }
}

/**
 * Detects Prisma unique constraint violation.
 * Prisma 7 throws PrismaClientKnownRequestError with code P2002.
 */
function isUniqueConstraintError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false
  }
  const err = error as { code?: string; name?: string }
  return err.code === 'P2002' || err.name === 'PrismaClientKnownRequestError'
}
