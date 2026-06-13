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
    const refreshToken = randomBytes(32).toString('hex')
    const refreshTokenHash = sha256Hex(refreshToken)
    const now = new Date()
    const expiresAt = new Date(now.getTime() + REFRESH_TOKEN_TTL_SECONDS * 1000)

    const sessionData: Session & { readonly consumed: boolean } = {
      sessionId,
      userId,
      refreshTokenHash,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      consumed: false,
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

    const session = JSON.parse(raw) as Session & { consumed: boolean }

    // Expiry check (belt and suspenders — Redis TTL is primary)
    if (new Date(session.expiresAt) < new Date()) {
      await this.revoke(userId, sessionId)
      return null
    }

    // Reuse detection: if the token was already consumed, this is a
    // stolen token being replayed. Revoke ALL sessions immediately.
    // Architecture: "Stolen refresh token used after legitimate rotation
    // → ALL sessions for that user immediately revoked."
    if (session.consumed) {
      await this.revokeAll(userId)
      return null
    }

    // Verify the token hash
    const suppliedHash = sha256Hex(refreshToken)
    if (suppliedHash !== session.refreshTokenHash) {
      return null
    }

    // Mark as consumed. The next call to `consume` with this token
    // triggers reuse detection.
    session.consumed = true
    const ttl = await this.redis.ttl(key)
    if (ttl > 0) {
      await this.redis.set(key, JSON.stringify(session), 'EX', ttl)
    }

    return session
  }

  public async rotate(
    userId: string,
    sessionId: string,
    oldRefreshToken: string,
  ): Promise<CreateSessionResult | null> {
    const valid = await this.consume(userId, sessionId, oldRefreshToken)
    if (valid === null) {
      return null
    }

    // Delete old session, create new one under the same user
    await this.revoke(userId, sessionId)
    return this.create(userId)
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
