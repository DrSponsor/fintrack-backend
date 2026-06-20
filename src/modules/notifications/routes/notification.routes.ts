import type { FastifyInstance } from 'fastify'
import { PrismaNotificationRepository } from '../repositories/notification.repo'
import { RegisterTokenUseCase } from '../use-cases/register-token.use-case'
import { UnregisterTokenUseCase } from '../use-cases/unregister-token.use-case'
import { GetPreferencesUseCase } from '../use-cases/get-preferences.use-case'
import { UpdatePreferencesUseCase } from '../use-cases/update-preferences.use-case'
import { authenticate } from '../../../core/middleware/authenticate'
import { successEnvelope } from '../../../core/http/envelope'
import {
  registerTokenJsonSchema,
  unregisterTokenJsonSchema,
  getPreferencesJsonSchema,
  updatePreferencesJsonSchema,
} from '../schemas/notification.schemas'

/**
 * Notification routing adapters.
 * Connects Fastify endpoints to underlying notification use cases.
 */
export function registerNotificationRoutes(fastify: FastifyInstance<any, any, any, any, any>): void {
  const notificationRepo = new PrismaNotificationRepository(fastify.db.primary)

  const registerTokenUseCase = new RegisterTokenUseCase({
    notificationRepo,
    logger: fastify.log,
  })

  const unregisterTokenUseCase = new UnregisterTokenUseCase({
    notificationRepo,
    logger: fastify.log,
  })

  const getPreferencesUseCase = new GetPreferencesUseCase({
    notificationRepo,
    logger: fastify.log,
  })

  const updatePreferencesUseCase = new UpdatePreferencesUseCase({
    notificationRepo,
    logger: fastify.log,
  })

  // ── POST /v1/notifications/tokens ─────────────────────────────────────
  fastify.post('/v1/notifications/tokens', {
    schema: registerTokenJsonSchema,
    preHandler: [authenticate],
    config: {
      rateLimit: { max: 30, window: 60 },
    },
  }, async (request, reply) => {
    const userId = request.user!.sub
    const result = await registerTokenUseCase.execute(userId, request.body)
    return reply.code(201).send(successEnvelope(result, request.requestId))
  })

  // ── DELETE /v1/notifications/tokens ──────────────────────────────────
  fastify.delete('/v1/notifications/tokens', {
    schema: unregisterTokenJsonSchema,
    preHandler: [authenticate],
    config: {
      rateLimit: { max: 30, window: 60 },
    },
  }, async (request, reply) => {
    const userId = request.user!.sub
    await unregisterTokenUseCase.execute(userId, request.body)
    return reply.code(200).send(successEnvelope({ message: 'Token unregistered successfully' }, request.requestId))
  })

  // ── GET /v1/notifications/preferences ──────────────────────────────────
  fastify.get('/v1/notifications/preferences', {
    schema: getPreferencesJsonSchema,
    preHandler: [authenticate],
  }, async (request, reply) => {
    const userId = request.user!.sub
    const result = await getPreferencesUseCase.execute(userId)
    return reply.code(200).send(successEnvelope(result, request.requestId))
  })

  // ── PUT /v1/notifications/preferences ──────────────────────────────────
  fastify.put('/v1/notifications/preferences', {
    schema: updatePreferencesJsonSchema,
    preHandler: [authenticate],
  }, async (request, reply) => {
    const userId = request.user!.sub
    const result = await updatePreferencesUseCase.execute(userId, request.body)
    return reply.code(200).send(successEnvelope(result, request.requestId))
  })
}
export type NotificationRoutes = typeof registerNotificationRoutes
