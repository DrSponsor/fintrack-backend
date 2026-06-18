import type { FastifyInstance } from 'fastify'
import { authenticate } from '../../../core/middleware/authenticate'
import { CreateCheckoutSessionUseCase } from '../use-cases/create-checkout-session.use-case'
import { createCheckoutBodySchema, createCheckoutJsonSchema } from '../schemas/billing.schemas'
import { successEnvelope } from '../../../core/http/envelope'
import type { BillingService } from '../services/billing.service'
import type { AppConfig } from '../../../config'

export function registerCheckoutRoute(
  fastify: FastifyInstance<any, any, any, any, any>,
  deps: { readonly billingService: BillingService; readonly appConfig: AppConfig }
): void {
  const createCheckoutUseCase = new CreateCheckoutSessionUseCase(deps)

  fastify.post('/v1/billing/checkout', {
    schema: createCheckoutJsonSchema,
    preHandler: [authenticate],
    config: {
      financialMutation: true,
      audit: { action: 'create_checkout_session', resourceType: 'billing' },
    },
  }, async (request, reply) => {
    const parsed = createCheckoutBodySchema.parse(request.body)
    const result = await createCheckoutUseCase.execute(request.user!.sub, parsed)
    return reply.code(201).send(successEnvelope(result, request.requestId))
  })
}
