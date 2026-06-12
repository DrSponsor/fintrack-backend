import type { FastifyInstance } from 'fastify'
import { checkDatabase } from '../config/database'
import { checkRedis } from '../config/redis'
import { dependencyUnavailable } from '../core/errors/factories'
import { successEnvelope } from '../core/http/envelope'

export type HealthChecks = {
  readonly database?: () => Promise<void>
  readonly redis?: () => Promise<void>
}

const successResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['success', 'data', 'requestId'],
  properties: {
    success: { type: 'boolean', const: true },
    data: {
      type: 'object',
      additionalProperties: false,
      required: ['status'],
      properties: {
        status: { type: 'string' },
      },
    },
    requestId: { type: 'string' },
  },
} as const

const errorResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['success', 'error', 'requestId'],
  properties: {
    success: { type: 'boolean', const: false },
    error: {
      type: 'object',
      additionalProperties: false,
      required: ['code', 'message'],
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
        field: { type: 'string' },
      },
    },
    requestId: { type: 'string' },
  },
} as const

export function registerHealthRoutes(fastify: FastifyInstance<any, any, any, any, any>, checks: HealthChecks = {}): void {
  fastify.get('/health/live', {
    schema: {
      response: {
        200: successResponseSchema,
      },
    },
  }, (request) => successEnvelope({ status: 'live' }, request.requestId))

  fastify.get('/health/ready', {
    schema: {
      response: {
        200: successResponseSchema,
        503: errorResponseSchema,
      },
    },
  }, async (request) => {
    const databaseCheck = checks.database ?? ((): Promise<void> => checkDatabase(fastify.db))
    const redisCheck = checks.redis ?? ((): Promise<void> => checkRedis(fastify.redis))

    try {
      await Promise.all([databaseCheck(), redisCheck()])
    } catch (error) {
      request.log.warn({ err: error }, 'readiness check failed')
      throw dependencyUnavailable('Service dependencies are not ready')
    }

    return successEnvelope({ status: 'ready' }, request.requestId)
  })
}
