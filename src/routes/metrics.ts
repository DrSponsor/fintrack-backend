import type { FastifyInstance } from 'fastify'
import { metricsRegistry } from '../core/observability/metrics'

export function registerMetricsRoute(fastify: FastifyInstance<any, any, any, any, any>): void {
  fastify.get('/metrics', async (_request, reply) => {
    reply.header('content-type', metricsRegistry.contentType)
    return metricsRegistry.metrics()
  })
}
