import type { FastifyInstance } from 'fastify'
import { authenticate } from '../../../core/middleware/authenticate'
import { successEnvelope } from '../../../core/http/envelope'
import type { InitiateDeletionUseCase } from '../use-cases/initiate-deletion.use-case'
import type { CancelDeletionUseCase } from '../use-cases/cancel-deletion.use-case'
import type { InitiateExportUseCase } from '../use-cases/initiate-export.use-case'
import type { IPrivacyRepository } from '../repositories/privacy.repo'
import {
  initiateDeletionJsonSchema,
  cancelDeletionJsonSchema,
  initiateExportJsonSchema,
  deletionStatusJsonSchema,
} from '../schemas/privacy.schemas'

export type PrivacyRouteDeps = {
  readonly initiateDeletionUseCase: InitiateDeletionUseCase
  readonly cancelDeletionUseCase: CancelDeletionUseCase
  readonly initiateExportUseCase: InitiateExportUseCase
  readonly privacyRepo: IPrivacyRepository
}

export function registerPrivacyRoutes(
  fastify: FastifyInstance<any, any, any, any, any>,
  deps: PrivacyRouteDeps
): void {
  // ── DELETE /v1/users/me/data — Initiate account deletion ──
  fastify.delete('/v1/users/me/data', {
    schema: initiateDeletionJsonSchema,
    preHandler: [authenticate],
    config: {
      financialMutation: true,
      audit: { action: 'initiate_account_deletion', resourceType: 'user' },
      rateLimit: { max: 3, window: 3600 },
    },
  }, async (request, reply) => {
    const result = await deps.initiateDeletionUseCase.execute(request.user!.sub)
    return reply.code(200).send(successEnvelope(result, request.requestId))
  })

  // ── POST /v1/users/me/data/cancel-deletion — Cancel pending deletion ──
  fastify.post('/v1/users/me/data/cancel-deletion', {
    schema: cancelDeletionJsonSchema,
    preHandler: [authenticate],
    config: {
      audit: { action: 'cancel_account_deletion', resourceType: 'user' },
    },
  }, async (request, reply) => {
    const result = await deps.cancelDeletionUseCase.execute(request.user!.sub)
    return reply.code(200).send(successEnvelope(result, request.requestId))
  })

  // ── POST /v1/users/me/data-export — Request data export ──
  fastify.post('/v1/users/me/data-export', {
    schema: initiateExportJsonSchema,
    preHandler: [authenticate],
    config: {
      audit: { action: 'request_data_export', resourceType: 'user' },
      rateLimit: { max: 3, window: 3600 },
    },
  }, async (request, reply) => {
    const result = await deps.initiateExportUseCase.execute(
      request.user!.sub,
      request.user!.email
    )
    return reply.code(202).send(successEnvelope(result, request.requestId))
  })

  // ── GET /v1/users/me/data/deletion-status — Check deletion status ──
  fastify.get('/v1/users/me/data/deletion-status', {
    schema: deletionStatusJsonSchema,
    preHandler: [authenticate],
  }, async (request, reply) => {
    const scheduledAt = await deps.privacyRepo.getDeletionScheduledAt(request.user!.sub)
    const data = scheduledAt !== null
      ? { pending: true, scheduledAt: scheduledAt.toISOString() }
      : { pending: false }
    return reply.code(200).send(successEnvelope(data, request.requestId))
  })
}
