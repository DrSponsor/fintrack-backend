import type { FastifyInstance } from 'fastify'
import { authenticate } from '../../../core/middleware/authenticate'
import { CancelSubscriptionUseCase } from '../use-cases/cancel-subscription.use-case'
import { cancelSubscriptionJsonSchema } from '../schemas/billing.schemas'
import { successEnvelope } from '../../../core/http/envelope'
import type { ISubscriptionRepository } from '../repositories/billing.repo'
import type { IBillingProvider } from '../providers/billing-provider.interface'

export function registerCancelRoute(
  fastify: FastifyInstance<any, any, any, any, any>,
  deps: { readonly subscriptionRepo: ISubscriptionRepository; readonly billingProvider: IBillingProvider }
): void {
  const cancelSubscriptionUseCase = new CancelSubscriptionUseCase(deps)

  fastify.post('/v1/billing/cancel', {
    schema: cancelSubscriptionJsonSchema,
    preHandler: [authenticate],
    config: {
      financialMutation: true,
      audit: { action: 'cancel_subscription', resourceType: 'billing' },
    },
  }, async (request, reply) => {
    const result = await cancelSubscriptionUseCase.execute(request.user!.sub)
    return reply.code(200).send(successEnvelope(result, request.requestId))
  })
}
