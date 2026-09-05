import type { AppFastifyInstance } from '../../../types/fastify'
import { RegisterUseCase } from '../use-cases/register.use-case'
import { LoginUseCase } from '../use-cases/login.use-case'
import { RefreshUseCase } from '../use-cases/refresh.use-case'
import { LogoutUseCase } from '../use-cases/logout.use-case'
import { GoogleAuthUseCase } from '../use-cases/google-auth.use-case'
import { PrismaUserRepository } from '../repositories/user.repo'
import { RedisSessionRepository, parseRefreshToken } from '../repositories/session.repo'
import { authenticate } from '../../../core/middleware/authenticate'
import { unauthenticated, validationError } from '../../../core/errors/factories'
import { successEnvelope } from '../../../core/http/envelope'
import {
  registerJsonSchema,
  loginJsonSchema,
  refreshJsonSchema,
  logoutJsonSchema,
  googleAuthJsonSchema,
  googleAuthBodySchema,
} from '../schemas/auth.schemas'

/**
 * Auth routes — thin adapters that delegate to use cases.
 *
 * No business logic here. Each handler:
 *   1. Extracts input from the request
 *   2. Calls the use case
 *   3. Returns the response envelope
 *
 * Dependency wiring:
 *   - Config flows through `fastify.appConfig` (decorated in app.ts)
 *   - DB flows through `fastify.db.primary` (decorated by 04-database plugin)
 *   - Redis flows through `fastify.redis` (decorated by 05-redis plugin)
 *   - Logger flows through `fastify.log` (Pino, configured at boot)
 *
 * No process.env reads. No service locators. Pure constructor injection.
 */
export function registerAuthRoutes(fastify: AppFastifyInstance): void {
  // ── Dependency wiring ──────────────────────────────────────────
  const userRepo = new PrismaUserRepository(fastify.db.primary)
  const sessionRepo = new RedisSessionRepository(fastify.redis)
  const jwtPrivateKeyPem = fastify.appConfig.jwtPrivateKeyPem ?? ''

  if (jwtPrivateKeyPem.length === 0) {
    fastify.log.warn('JWT_PRIVATE_KEY_PEM not configured — auth routes will fail at runtime')
  }

  const registerUseCase = new RegisterUseCase({
    userRepo,
    sessionRepo,
    jwtPrivateKeyPem,
    logger: fastify.log,
  })

  const loginUseCase = new LoginUseCase({
    userRepo,
    sessionRepo,
    jwtPrivateKeyPem,
    logger: fastify.log,
  })

  const refreshUseCase = new RefreshUseCase({
    userRepo,
    sessionRepo,
    jwtPrivateKeyPem,
    logger: fastify.log,
  })

  const logoutUseCase = new LogoutUseCase({
    sessionRepo,
    logger: fastify.log,
  })

  const googleAuthUseCase = new GoogleAuthUseCase({
    userRepo,
    sessionRepo,
    googleClientId: fastify.appConfig.googleClientId,
    jwtPrivateKeyPem,
    logger: fastify.log,
  })

  // ── POST /v1/auth/register ─────────────────────────────────────
  fastify.post('/v1/auth/register', {
    schema: registerJsonSchema,
    config: {
      audit: { action: 'register', resourceType: 'user' },
      rateLimit: { max: 20, window: 60 },
    },
  }, async (request, reply) => {
    const result = await registerUseCase.execute(request.body)

    reply.setCookie('refreshToken', result.refreshToken, {
      path: '/v1/auth',
      httpOnly: true,
      secure: fastify.appConfig.nodeEnv === 'production',
      sameSite: 'strict',
      maxAge: 30 * 24 * 60 * 60,
    })

    // Include refreshToken in body for mobile clients
    return reply.code(201).send(successEnvelope(
      {
        userId: result.userId,
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        expiresIn: result.expiresIn,
      },
      request.requestId,
    ))
  })

  // ── POST /v1/auth/login ────────────────────────────────────────
  fastify.post('/v1/auth/login', {
    schema: loginJsonSchema,
    config: {
      audit: { action: 'login', resourceType: 'session' },
      rateLimit: { max: 20, window: 60 },
    },
  }, async (request, reply) => {
    const result = await loginUseCase.execute(request.body)

    reply.setCookie('refreshToken', result.refreshToken, {
      path: '/v1/auth',
      httpOnly: true,
      secure: fastify.appConfig.nodeEnv === 'production',
      sameSite: 'strict',
      maxAge: 30 * 24 * 60 * 60,
    })

    // Include refreshToken in body for mobile clients
    return reply.code(200).send(successEnvelope(
      {
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        expiresIn: result.expiresIn,
      },
      request.requestId,
    ))
  })

  // ── POST /v1/auth/refresh ──────────────────────────────────────
  // Accepts refresh token from EITHER:
  //   1. httpOnly cookie (web clients)
  //   2. Request body `{ refreshToken }` (mobile clients — no cookie jar)
  // This is standard practice for multi-platform auth (Spotify, Revolut, etc.)
  //
  // Deliberately NOT behind `authenticate`.
  //
  // It used to be, and that made refreshing impossible: the 07-auth plugin
  // rejects an expired bearer token for every route on the server, and an
  // expired access token is the only reason this endpoint is ever called. The
  // client would 401, call refresh with the same expired token, get 401 again,
  // and log the user out — roughly fifteen minutes after they signed in.
  //
  // A refresh token is itself a bearer credential; requiring a second, shorter
  // lived one alongside it bought nothing. What actually defends this endpoint
  // is one-time-use rotation with reuse detection (see RedisSessionRepository)
  // plus the rate limit below, which now matters because the route is
  // reachable unauthenticated.
  fastify.post('/v1/auth/refresh', {
    schema: refreshJsonSchema,
    config: {
      // Higher than login's 20 because this key is now the IP for everyone —
      // there is no authenticated user to key on — and Nigerian mobile
      // carriers put very large numbers of subscribers behind one address.
      // Guessing is not the threat this defends against in any case: a
      // refresh token is 32 random bytes and is not reachable by brute force
      // at any rate limit. This bounds abuse, nothing more.
      rateLimit: { max: 60, window: 60 },
    },
  }, async (request, reply) => {
    // Try cookie first (web), fall back to body (mobile)
    const body = request.body as { refreshToken?: string } | undefined
    const refreshToken = request.cookies.refreshToken ?? body?.refreshToken
    if (refreshToken === undefined || refreshToken.length === 0) {
      throw unauthenticated('Refresh token missing')
    }

    // The token states which session it belongs to. Nothing is trusted on the
    // strength of that alone — the hash comparison inside rotate() is what
    // authenticates it; this only says which record to compare against.
    const identity = parseRefreshToken(refreshToken)
    if (identity === null) {
      throw unauthenticated('Refresh token is malformed')
    }

    const result = await refreshUseCase.execute(
      identity.userId,
      identity.sessionId,
      refreshToken,
    )

    // Set cookie for web clients (mobile clients ignore this)
    reply.setCookie('refreshToken', result.refreshToken, {
      path: '/v1/auth',
      httpOnly: true,
      secure: fastify.appConfig.nodeEnv === 'production',
      sameSite: 'strict',
      maxAge: 30 * 24 * 60 * 60,
    })

    // Include refreshToken in body for mobile clients
    return reply.code(200).send(successEnvelope(
      {
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        expiresIn: result.expiresIn,
      },
      request.requestId,
    ))
  })

  // ── POST /v1/auth/logout ───────────────────────────────────────
  fastify.post('/v1/auth/logout', {
    schema: logoutJsonSchema,
    preHandler: [authenticate],
    config: {
      audit: { action: 'logout', resourceType: 'session' },
    },
  }, async (request, reply) => {
    if (request.user === undefined || request.user.sid === undefined) {
      throw unauthenticated('Session identifier missing from token')
    }

    await logoutUseCase.execute(request.user.sub, request.user.sid)

    reply.clearCookie('refreshToken', {
      path: '/v1/auth',
    })

    return reply.code(200).send(successEnvelope(
      { message: 'Logged out successfully' },
      request.requestId,
    ))
  })

  // ── POST /v1/auth/google ───────────────────────────────────────
  fastify.post('/v1/auth/google', {
    schema: googleAuthJsonSchema,
    config: {
      audit: { action: 'google_login', resourceType: 'session' },
      rateLimit: { max: 20, window: 60 },
    },
  }, async (request, reply) => {
    const parsed = googleAuthBodySchema.safeParse(request.body)
    if (!parsed.success) {
      throw validationError(parsed.error.issues[0]?.message ?? 'Invalid request body')
    }

    const { idToken } = parsed.data
    const result = await googleAuthUseCase.execute(idToken)

    reply.setCookie('refreshToken', result.refreshToken, {
      path: '/v1/auth',
      httpOnly: true,
      secure: fastify.appConfig.nodeEnv === 'production',
      sameSite: 'strict',
      maxAge: 30 * 24 * 60 * 60,
    })

    return reply.code(200).send(successEnvelope(
      {
        userId: result.userId,
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        expiresIn: result.expiresIn,
      },
      request.requestId,
    ))
  })
}
