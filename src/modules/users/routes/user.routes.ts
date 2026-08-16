import type { AppFastifyInstance } from '../../../types/fastify'
import { GetProfileUseCase } from '../use-cases/get-profile.use-case'
import { UpdateProfileUseCase } from '../use-cases/update-profile.use-case'
import { PrismaUserProfileRepository } from '../repositories/user-profile.repo'
import { authenticate, requireUser } from '../../../core/middleware/authenticate'
import { successEnvelope } from '../../../core/http/envelope'
import {
  profileJsonSchema,
  updateProfileJsonSchema,
} from '../schemas/user.schemas'

/**
 * User routes — profile management and NDPR data operations.
 *
 * All routes require authentication. Ownership is implicit —
 * the user can only access their own profile via `request.user.sub`.
 * There is no `:userId` param to prevent IDOR.
 */
export function registerUserRoutes(fastify: AppFastifyInstance): void {
  const userProfileRepo = new PrismaUserProfileRepository(fastify.db.primary)

  const getProfileUseCase = new GetProfileUseCase({
    userProfileRepo,
    logger: fastify.log,
  })

  const updateProfileUseCase = new UpdateProfileUseCase({
    userProfileRepo,
    logger: fastify.log,
  })

  // ── GET /v1/users/me ───────────────────────────────────────────
  fastify.get('/v1/users/me', {
    schema: profileJsonSchema,
    preHandler: [authenticate],
  }, async (request) => {
    const profile = await getProfileUseCase.execute(requireUser(request).sub)

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
    const profile = await updateProfileUseCase.execute(requireUser(request).sub, request.body)

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
}
