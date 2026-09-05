import { randomUUID, randomBytes } from 'node:crypto'
import type { Redis } from 'ioredis'
import { sha256Hex } from '../../../core/crypto/hashing'

// ──────────────────────────────────────────────────────────────────
// Domain types
// ──────────────────────────────────────────────────────────────────

export type Session = {
  readonly sessionId: string
  readonly userId: string
  readonly refreshTokenHash: string
  readonly lastRefreshTokenHash?: string
  readonly createdAt: string
  readonly expiresAt: string
}

export type CreateSessionResult = {
  readonly sessionId: string
  readonly refreshToken: string
}

// ──────────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────────

/** Refresh token lifetime: 30 days in seconds */
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60

/**
 * A refresh token carries the identity it refreshes.
 *
 * It used to be 32 opaque random bytes, and the identity it belonged to was
 * read from the ACCESS token on the refresh request instead — which meant
 * POST /v1/auth/refresh required a valid access token. That is a circular
 * requirement: the only reason to call refresh is that the access token has
 * expired, so refreshing was impossible by construction and every session
 * ended 15 minutes after sign-in.
 *
 * Making the token self-describing is what lets the endpoint drop its
 * `authenticate` preHandler. The secret is still 32 random bytes and the
 * stored hash still covers the whole string, so knowing the userId and
 * sessionId — both already visible to anyone holding the token — gets an
 * attacker no closer to forging one.
 */
function mintRefreshToken(userId: string, sessionId: string): string {
  return `${userId}.${sessionId}.${randomBytes(32).toString('hex')}`
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SECRET_HEX_LENGTH = 64

/**
 * Reads the identity out of a refresh token, or null if it is not one.
 *
 * Null here means "not a token this server minted" — a truncated string, a
 * token from before this format, or something invented. It is not proof of
 * anything beyond that: the token still has to survive the hash comparison in
 * `consume` before it authenticates anybody.
 */
export function parseRefreshToken(
  token: string,
): { readonly userId: string; readonly sessionId: string } | null {
  const parts = token.split('.')
  if (parts.length !== 3) {
    return null
  }
  const [userId, sessionId, secret] = parts
  if (userId === undefined || sessionId === undefined || secret === undefined) {
    return null
  }
  if (!UUID_PATTERN.test(userId) || !UUID_PATTERN.test(sessionId)) {
    return null
  }
  if (secret.length !== SECRET_HEX_LENGTH) {
    return null
  }
  return { userId, sessionId }
}

/** Redis key prefix for individual sessions */
function sessionKey(userId: string, sessionId: string): string {
  return `session:${userId}:${sessionId}`
}

/** Redis key prefix for the set of all session IDs per user */
function userSessionsKey(userId: string): string {
  return `sessions:${userId}`
}

// ──────────────────────────────────────────────────────────────────
// Repository interface
// ──────────────────────────────────────────────────────────────────

export interface ISessionRepository {
  /**
   * Create a new session with a fresh refresh token.
   * Returns the session ID and the raw refresh token (sent to client once).
   */
  create(userId: string): Promise<CreateSessionResult>

  /**
   * Validate and consume a refresh token (one-time use).
   * Returns the session if valid, null otherwise.
   *
   * On reuse detection (token already consumed): revokes ALL sessions
   * for the user and returns null. This is the stolen-token defence.
   */
  consume(userId: string, sessionId: string, refreshToken: string): Promise<Session | null>

  /**
   * Rotate: consume old token and issue a new one in the same session.
   * Returns null if the old token is invalid (triggers revokeAll internally).
   */
  rotate(userId: string, sessionId: string, oldRefreshToken: string): Promise<CreateSessionResult | null>

  /** Revoke a single session (logout from one device). */
  revoke(userId: string, sessionId: string): Promise<void>

  /** Revoke ALL sessions for a user (stolen token detected, password change). */
  revokeAll(userId: string): Promise<void>
}

// ──────────────────────────────────────────────────────────────────
// Redis implementation
//
// Storage layout:
//   session:{userId}:{sessionId} → JSON { refreshTokenHash, createdAt, expiresAt, consumed }
//   sessions:{userId}            → Redis SET of sessionIds
//
// Refresh token is stored as a SHA256 hash. The raw token is only
// returned to the client once at creation/rotation. If an attacker
// compromises Redis, they cannot derive the raw tokens.
// ──────────────────────────────────────────────────────────────────

export class RedisSessionRepository implements ISessionRepository {
  private readonly redis: Redis

  public constructor(redis: Redis) {
    this.redis = redis
  }

  public async create(userId: string): Promise<CreateSessionResult> {
    const sessionId = randomUUID()
    const refreshToken = mintRefreshToken(userId, sessionId)
    const refreshTokenHash = sha256Hex(refreshToken)
    const now = new Date()
    const expiresAt = new Date(now.getTime() + REFRESH_TOKEN_TTL_SECONDS * 1000)

    const sessionData: Session = {
      sessionId,
      userId,
      refreshTokenHash,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    }

    const key = sessionKey(userId, sessionId)
    await this.redis.set(key, JSON.stringify(sessionData), 'EX', REFRESH_TOKEN_TTL_SECONDS)
    await this.redis.sadd(userSessionsKey(userId), sessionId)

    return { sessionId, refreshToken }
  }

  public async consume(
    userId: string,
    sessionId: string,
    refreshToken: string,
  ): Promise<Session | null> {
    const key = sessionKey(userId, sessionId)
    const raw = await this.redis.get(key)

    if (raw === null) {
      return null
    }

    const session = JSON.parse(raw) as Session

    // Expiry check (belt and suspenders — Redis TTL is primary)
    if (new Date(session.expiresAt) < new Date()) {
      await this.revoke(userId, sessionId)
      return null
    }

    const suppliedHash = sha256Hex(refreshToken)

    // Reuse detection: if the token matches the last used refresh token hash,
    // this is a stolen token being replayed. Revoke ALL sessions immediately.
    if (session.lastRefreshTokenHash && suppliedHash === session.lastRefreshTokenHash) {
      await this.revokeAll(userId)
      return null
    }

    // Verify the token hash
    if (suppliedHash !== session.refreshTokenHash) {
      return null
    }

    return session
  }

  public async rotate(
    userId: string,
    sessionId: string,
    oldRefreshToken: string,
  ): Promise<CreateSessionResult | null> {
    const session = await this.consume(userId, sessionId, oldRefreshToken)
    if (session === null) {
      return null
    }

    const newRefreshToken = mintRefreshToken(userId, sessionId)
    const newRefreshTokenHash = sha256Hex(newRefreshToken)
    const now = new Date()
    const expiresAt = new Date(now.getTime() + REFRESH_TOKEN_TTL_SECONDS * 1000)

    const updatedSession: Session = {
      sessionId,
      userId,
      refreshTokenHash: newRefreshTokenHash,
      lastRefreshTokenHash: session.refreshTokenHash,
      createdAt: session.createdAt,
      expiresAt: expiresAt.toISOString(),
    }

    const key = sessionKey(userId, sessionId)
    await this.redis.set(key, JSON.stringify(updatedSession), 'EX', REFRESH_TOKEN_TTL_SECONDS)

    return { sessionId, refreshToken: newRefreshToken }
  }

  public async revoke(userId: string, sessionId: string): Promise<void> {
    await this.redis.del(sessionKey(userId, sessionId))
    await this.redis.srem(userSessionsKey(userId), sessionId)
  }

  public async revokeAll(userId: string): Promise<void> {
    const sessionIds = await this.redis.smembers(userSessionsKey(userId))

    if (sessionIds.length > 0) {
      const keys = sessionIds.map((id) => sessionKey(userId, id))
      await this.redis.del(...keys)
    }

    await this.redis.del(userSessionsKey(userId))
  }
}
