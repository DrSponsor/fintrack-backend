import CircuitBreaker from 'opossum'
import type { AppLogger } from '../../../core/logger'
import type { IUserRepository } from '../repositories/user.repo'
import type { ISessionRepository } from '../repositories/session.repo'
import { signAccessToken } from '../../../core/crypto/tokens'
import type { AccessTokenPayload } from '../../../core/crypto/tokens'
import { unauthenticated, dependencyUnavailable } from '../../../core/errors/factories'

// ──────────────────────────────────────────────────────────────────
// Result type
// ──────────────────────────────────────────────────────────────────

export type GoogleAuthResult = {
  readonly userId: string
  readonly accessToken: string
  readonly refreshToken: string
  readonly sessionId: string
  readonly expiresIn: number
}

// ──────────────────────────────────────────────────────────────────
// Use case
// ──────────────────────────────────────────────────────────────────

export type GoogleAuthUseCaseDeps = {
  readonly userRepo: IUserRepository
  readonly sessionRepo: ISessionRepository
  readonly googleClientId: string | undefined
  readonly jwtPrivateKeyPem: string
  readonly logger: AppLogger
}

export class GoogleAuthUseCase {
  private readonly userRepo: IUserRepository
  private readonly sessionRepo: ISessionRepository
  private readonly googleClientId: string | undefined
  private readonly jwtPrivateKeyPem: string
  private readonly logger: AppLogger
  private readonly breaker: CircuitBreaker<[string], any>

  public constructor(deps: GoogleAuthUseCaseDeps) {
    this.userRepo = deps.userRepo
    this.sessionRepo = deps.sessionRepo
    this.googleClientId = deps.googleClientId
    this.jwtPrivateKeyPem = deps.jwtPrivateKeyPem
    this.logger = deps.logger

    // Law 9 — External call protected by circuit breaker
    this.breaker = new CircuitBreaker(
      this.fetchTokenInfo.bind(this),
      {
        timeout: 10000, // 10 seconds timeout
        errorThresholdPercentage: 50,
        resetTimeout: 30000,
      }
    )
  }

  private async fetchTokenInfo(idToken: string): Promise<any> {
    const url = `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`
    const response = await fetch(url)
    if (!response.ok) {
      const text = await response.text().catch(() => 'Unknown error')
      throw new Error(`Google API error [${response.status}]: ${text}`)
    }
    return response.json()
  }

  public async execute(idToken: string): Promise<GoogleAuthResult> {
    if (!this.googleClientId || this.googleClientId.length === 0) {
      this.logger.error('Google Client ID is not configured on the server')
      throw dependencyUnavailable('Google authentication service is currently unavailable')
    }

    let tokenInfo: any
    try {
      tokenInfo = await this.breaker.fire(idToken)
    } catch (err) {
      this.logger.error({ err }, 'Google token verification failed or timed out')
      if (this.breaker.opened) {
        throw dependencyUnavailable('Google authentication service is currently unavailable')
      }
      throw unauthenticated('Invalid Google identity token')
    }

    const { sub: googleId, email, email_verified, aud } = tokenInfo as {
      readonly sub?: string
      readonly email?: string
      readonly email_verified?: string | boolean
      readonly aud?: string
    }

    if (!googleId || !email || !aud) {
      throw unauthenticated('Google identity token is missing required claims')
    }

    const isEmailVerified = email_verified === true || email_verified === 'true'
    if (!isEmailVerified) {
      throw unauthenticated('Google account email is not verified')
    }

    if (aud !== this.googleClientId) {
      this.logger.warn({ aud, expected: this.googleClientId }, 'Google ID token audience mismatch')
      throw unauthenticated('Google identity token audience mismatch')
    }

    let user = await this.userRepo.findByGoogleId(googleId)
    if (user === null) {
      // Find if email is already registered
      user = await this.userRepo.findByEmail(email)
      if (user !== null) {
        // Link Google ID to existing user account
        await this.userRepo.linkGoogleId(user.id, googleId)
        user = { ...user, googleId }
        this.logger.info({ userId: user.id }, 'Linked Google ID to existing user email')
      } else {
        // Register new user (Law 8 — Insert-then-catch pattern)
        try {
          user = await this.userRepo.create({ email, googleId })
          this.logger.info({ userId: user.id }, 'Registered new user via Google authentication')
        } catch (error: unknown) {
          if (isUniqueConstraintError(error)) {
            // Concurrent registration race fallback
            user = await this.userRepo.findByEmail(email)
            if (user === null) {
              throw error
            }
            if (user.googleId === null) {
              await this.userRepo.linkGoogleId(user.id, googleId)
              user = { ...user, googleId }
            }
          } else {
            throw error
          }
        }
      }
    }

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
      expiresIn: 900, // 15 minutes
    }
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false
  }
  const err = error as { code?: string; name?: string }
  return err.code === 'P2002' || err.name === 'PrismaClientKnownRequestError'
}
