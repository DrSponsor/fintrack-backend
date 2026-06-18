import { Readable } from 'node:stream'
import type { FastifyInstance } from 'fastify'
import type { IBillingProvider } from '../providers/billing-provider.interface'
import type { IBillingRepository } from '../repositories/billing.repo'
import { ProcessWebhookUseCase } from '../use-cases/process-webhook.use-case'

export function registerWebhookRoute(
  fastify: FastifyInstance<any, any, any, any, any>,
  deps: { readonly billingProvider: IBillingProvider; readonly billingRepo: IBillingRepository }
): void {
  const useCase = new ProcessWebhookUseCase({
    billingProvider: deps.billingProvider,
    billingRepo: deps.billingRepo,
    queues: fastify.queues,
  })
  
  fastify.post('/v1/billing/webhook', {
    // Route-level preParsing hook to capture the raw body for signature verification
    preParsing: [
      async (request, _reply, payload) => {
        const chunks: Buffer[] = []
        for await (const chunk of payload) {
          chunks.push(chunk)
        }
        const rawBody = Buffer.concat(chunks)
        // Attach the raw body string to the request context
        ;(request as unknown as { rawBody: string }).rawBody = rawBody.toString('utf8')
        
        // Return a new readable stream so Fastify can parse the JSON body normally
        return Readable.from(rawBody)
      }
    ],
    // Disable any auth middleware for this route since Paystack calls it unauthenticated.
    config: {
      rateLimit: { max: 1000, window: 60 },
    },
  }, async (request, reply) => {
    try {
      const signatureHeader = request.headers['x-paystack-signature'] as string | undefined
      const rawBody = (request as unknown as { rawBody?: string }).rawBody

      const result = await useCase.execute({
        signatureHeader,
        rawBody,
        body: request.body,
      })

      return reply.code(200).send(result)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      
      // Return 400 Bad Request for validation/signature rejections
      if (
        msg === 'Missing signature header' ||
        msg === 'Invalid signature' ||
        msg === 'Missing event type in payload' ||
        msg === 'Missing event identifier'
      ) {
        fastify.log.warn({ requestId: request.id, err }, 'Webhook validation rejected')
        return reply.status(400).send({ error: msg })
      }
      throw err
    }
  })
}
