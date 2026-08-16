import type { AppFastifyInstance } from '../../../types/fastify'
import { authenticate, requireUser } from '../../../core/middleware/authenticate'
import { successEnvelope } from '../../../core/http/envelope'
import type { InitiateDeletionUseCase } from '../use-cases/initiate-deletion.use-case'
import type { CancelDeletionUseCase } from '../use-cases/cancel-deletion.use-case'
import type { InitiateExportUseCase } from '../use-cases/initiate-export.use-case'
import type { IPrivacyRepository } from '../repositories/privacy.repo'
import type { IEmailAccessLogRepository } from '../../capture/email/repositories/email-access-log.repo'
import {
  initiateDeletionJsonSchema,
  cancelDeletionJsonSchema,
  initiateExportJsonSchema,
  deletionStatusJsonSchema,
  emailAccessLogJsonSchema,
} from '../schemas/privacy.schemas'

export type PrivacyRouteDeps = {
  readonly initiateDeletionUseCase: InitiateDeletionUseCase
  readonly cancelDeletionUseCase: CancelDeletionUseCase
  readonly initiateExportUseCase: InitiateExportUseCase
  readonly privacyRepo: IPrivacyRepository
  readonly emailAccessLogRepo: IEmailAccessLogRepository
}

export function registerPrivacyRoutes(
  fastify: AppFastifyInstance,
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
    const result = await deps.initiateDeletionUseCase.execute(requireUser(request).sub)
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
    const result = await deps.cancelDeletionUseCase.execute(requireUser(request).sub)
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
      requireUser(request).sub,
      requireUser(request).email
    )
    return reply.code(202).send(successEnvelope(result, request.requestId))
  })

  // ── GET /v1/users/me/data/deletion-status — Check deletion status ──
  fastify.get('/v1/users/me/data/deletion-status', {
    schema: deletionStatusJsonSchema,
    preHandler: [authenticate],
  }, async (request, reply) => {
    const scheduledAt = await deps.privacyRepo.getDeletionScheduledAt(requireUser(request).sub)
    const data = scheduledAt !== null
      ? { pending: true, scheduledAt: scheduledAt.toISOString() }
      : { pending: false }
    return reply.code(200).send(successEnvelope(data, request.requestId))
  })

  // ── GET /v1/privacy/email-access-log — NDPR transparency log ──
  // Every email the system has ever accessed for this user via the
  // Gmail capture pipeline, regardless of what happened to it.
  fastify.get('/v1/privacy/email-access-log', {
    schema: emailAccessLogJsonSchema,
    preHandler: [authenticate],
  }, async (request, reply) => {
    const query = request.query as { cursor?: string; limit?: number }
    const result = await deps.emailAccessLogRepo.findByUser(
      requireUser(request).sub,
      query.cursor,
      query.limit,
    )

    const lastItem = result.data[result.data.length - 1]

    return reply.code(200).send(
      successEnvelope(
        result.data.map((row) => ({
          id: row.id,
          messageId: row.messageId,
          senderDomain: row.senderDomain,
          subject: row.subject,
          outcome: row.outcome,
          accessedAt: row.accessedAt.toISOString(),
        })),
        request.requestId,
        {
          cursor: lastItem?.id,
          hasMore: result.hasMore,
        },
      ),
    )
  })
}
