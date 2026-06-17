import type { FastifyInstance } from 'fastify'
import { RegisterUseCase } from '../use-cases/register.use-case'
import { LoginUseCase } from '../use-cases/login.use-case'
import { RefreshUseCase } from '../use-cases/refresh.use-case'
import { LogoutUseCase } from '../use-cases/logout.use-case'
import { PrismaUserRepository } from '../repositories/user.repo'
import { RedisSessionRepository } from '../repositories/session.repo'
import { authenticate } from '../../../core/middleware/authenticate'
import { unauthenticated } from '../../../core/errors/factories'
import { successEnvelope } from '../../../core/http/envelope'
import {
  registerJsonSchema,
  loginJsonSchema,
  refreshJsonSchema,
  logoutJsonSchema,
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
export function registerAuthRoutes(fastify: FastifyInstance<any, any, any, any, any>): void {
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

    return reply.code(201).send(successEnvelope(
      {
        userId: result.userId,
        accessToken: result.accessToken,
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

    return reply.code(200).send(successEnvelope(
      {
        accessToken: result.accessToken,
        expiresIn: result.expiresIn,
      },
      request.requestId,
    ))
  })

  // ── POST /v1/auth/refresh ──────────────────────────────────────
  fastify.post('/v1/auth/refresh', {
    schema: refreshJsonSchema,
    preHandler: [authenticate],
  }, async (request, reply) => {
    if (request.user === undefined || request.user.sid === undefined) {
      throw unauthenticated('Session identifier missing from token')
    }

    const refreshToken = request.cookies.refreshToken
    if (refreshToken === undefined || refreshToken.length === 0) {
      throw unauthenticated('Refresh token missing')
    }

    const result = await refreshUseCase.execute(
      request.user.sub,
      request.user.sid,
      refreshToken,
    )

    reply.setCookie('refreshToken', result.refreshToken, {
      path: '/v1/auth',
      httpOnly: true,
      secure: fastify.appConfig.nodeEnv === 'production',
      sameSite: 'strict',
      maxAge: 30 * 24 * 60 * 60,
    })

    return reply.code(200).send(successEnvelope(
      {
        accessToken: result.accessToken,
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
}
