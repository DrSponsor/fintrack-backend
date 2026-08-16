import type { AppFastifyInstance } from '../types/fastify'
import { metricsRegistry } from '../core/observability/metrics'

export function registerMetricsRoute(fastify: AppFastifyInstance): void {
  fastify.get('/metrics', async (_request, reply) => {
    reply.header('content-type', metricsRegistry.contentType)
    return metricsRegistry.metrics()
  })
}
