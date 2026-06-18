import type { FastifyInstance } from 'fastify'
import { authenticate } from '../../../core/middleware/authenticate'
import { GetSubscriptionStatusUseCase } from '../use-cases/get-subscription-status.use-case'
import { subscriptionStatusJsonSchema } from '../schemas/billing.schemas'
import { successEnvelope } from '../../../core/http/envelope'
import type { ISubscriptionRepository } from '../repositories/billing.repo'

export function registerSubscriptionRoute(
  fastify: FastifyInstance<any, any, any, any, any>,
  deps: { readonly subscriptionRepo: ISubscriptionRepository }
): void {
  const getSubscriptionStatusUseCase = new GetSubscriptionStatusUseCase(deps)

  fastify.get('/v1/billing/status', {
    schema: subscriptionStatusJsonSchema,
    preHandler: [authenticate],
  }, async (request, reply) => {
    const result = await getSubscriptionStatusUseCase.execute(request.user!.sub)
    const formatted = {
      status: result.status,
      currentPeriodEnd: result.currentPeriodEnd ? result.currentPeriodEnd.toISOString() : null,
    }
    return reply.code(200).send(successEnvelope(formatted, request.requestId))
  })
}
