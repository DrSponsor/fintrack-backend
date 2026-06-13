import type { FastifyInstance } from 'fastify'
import { GetProfileUseCase } from '../use-cases/get-profile.use-case'
import { UpdateProfileUseCase } from '../use-cases/update-profile.use-case'
import { DeleteDataUseCase } from '../use-cases/delete-data.use-case'
import { PrismaUserProfileRepository } from '../repositories/user-profile.repo'
import { RedisSessionRepository } from '../../auth/repositories/session.repo'
import { authenticate } from '../../../core/middleware/authenticate'
import { successEnvelope } from '../../../core/http/envelope'
import {
  profileJsonSchema,
  updateProfileJsonSchema,
  deleteDataJsonSchema,
} from '../schemas/user.schemas'

/**
 * User routes — profile management and NDPR data operations.
 *
 * All routes require authentication. Ownership is implicit —
 * the user can only access their own profile via `request.user.sub`.
 * There is no `:userId` param to prevent IDOR.
 */
export function registerUserRoutes(fastify: FastifyInstance<any, any, any, any, any>): void {
  const userProfileRepo = new PrismaUserProfileRepository(fastify.db.primary)
  const sessionRepo = new RedisSessionRepository(fastify.redis)

  const getProfileUseCase = new GetProfileUseCase({
    userProfileRepo,
    logger: fastify.log,
  })

  const updateProfileUseCase = new UpdateProfileUseCase({
    userProfileRepo,
    logger: fastify.log,
  })

  const deleteDataUseCase = new DeleteDataUseCase({
    userProfileRepo,
    sessionRepo,
    redis: fastify.redis,
    logger: fastify.log,
  })

  // ── GET /v1/users/me ───────────────────────────────────────────
  fastify.get('/v1/users/me', {
    schema: profileJsonSchema,
    preHandler: [authenticate],
  }, async (request) => {
    const profile = await getProfileUseCase.execute(request.user!.sub)

    return successEnvelope(
      {
        id: profile.id,
        email: profile.email,
        phone: profile.phone,
        tier: profile.tier,
        accountCount: profile.accountCount,
        createdAt: profile.createdAt.toISOString(),
      },
      request.requestId,
    )
  })

  // ── PATCH /v1/users/me ─────────────────────────────────────────
  fastify.patch('/v1/users/me', {
    schema: updateProfileJsonSchema,
    preHandler: [authenticate],
    config: {
      audit: { action: 'update_profile', resourceType: 'user' },
    },
  }, async (request) => {
    const profile = await updateProfileUseCase.execute(request.user!.sub, request.body)

    return successEnvelope(
      {
        id: profile.id,
        email: profile.email,
        phone: profile.phone,
        tier: profile.tier,
        createdAt: profile.createdAt.toISOString(),
      },
      request.requestId,
    )
  })

  // ── DELETE /v1/users/me/data ───────────────────────────────────
  // NDPR deletion with 24-hour cooling-off period
  fastify.delete('/v1/users/me/data', {
    schema: deleteDataJsonSchema,
    preHandler: [authenticate],
    config: {
      audit: { action: 'request_data_deletion', resourceType: 'user' },
    },
  }, async (request) => {
    const result = await deleteDataUseCase.execute(request.user!.sub)

    return successEnvelope(result, request.requestId)
  })
}
