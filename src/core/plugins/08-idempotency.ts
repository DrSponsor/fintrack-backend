import fp from 'fastify-plugin'
import type { FastifyPluginCallback } from 'fastify'
import { ensureRedisConnected } from '../../config/redis'
import { sha256Hex } from '../crypto/hashing'
import { AppError } from '../errors/AppError'
import { ERROR_CODES } from '../errors/codes'

type CachedResponse = {
  readonly statusCode: number
  readonly contentType: string
  readonly payload: string
}

function isFinancialMutation(config: unknown): boolean {
  return typeof config === 'object'
    && config !== null
    && 'financialMutation' in config
    && (config as { readonly financialMutation?: unknown }).financialMutation === true
}

function isCachedResponse(value: unknown): value is CachedResponse {
  return typeof value === 'object'
    && value !== null
    && typeof (value as { readonly statusCode?: unknown }).statusCode === 'number'
    && typeof (value as { readonly contentType?: unknown }).contentType === 'string'
    && typeof (value as { readonly payload?: unknown }).payload === 'string'
}

function payloadToString(payload: unknown): string {
  if (typeof payload === 'string') {
    return payload
  }
  if (Buffer.isBuffer(payload)) {
    return payload.toString('utf8')
  }
  if (payload === null || payload === undefined) {
    return ''
  }
  if (typeof payload === 'number' || typeof payload === 'boolean' || typeof payload === 'bigint') {
    return payload.toString()
  }
  if (typeof payload === 'symbol') {
    return payload.toString()
  }
  if (typeof payload === 'function') {
    return ''
  }
  return JSON.stringify(payload) ?? ''
}

export const idempotencyPlugin: FastifyPluginCallback = fp((fastify, _options, done) => {
  fastify.decorateRequest('idempotency')

  fastify.addHook('preHandler', async (request, reply) => {
    if (!isFinancialMutation(request.routeOptions.config)) {
      return
    }

    const keyHeader = request.headers['idempotency-key']
    if (typeof keyHeader !== 'string' || keyHeader.trim().length === 0) {
      throw new AppError(ERROR_CODES.IDEMPOTENCY_REQUIRED, 'Idempotency-Key header is required', 409)
    }

    await ensureRedisConnected(fastify.redis)

    const scope = request.user?.sub ?? request.ip
    const keyHash = sha256Hex(`${scope}:${keyHeader}`)
    const lockKey = `idempotency:lock:${keyHash}`
    const responseKey = `idempotency:response:${keyHash}`
    const cached = await fastify.redis.get(responseKey)

    if (cached !== null) {
      const parsed: unknown = JSON.parse(cached)
      if (!isCachedResponse(parsed)) {
        throw new AppError(ERROR_CODES.INTERNAL, 'Invalid cached idempotency response', 500)
      }
      reply.code(parsed.statusCode).type(parsed.contentType).send(parsed.payload)
      return reply
    }

    const inserted = await fastify.redis.set(lockKey, 'processing', 'EX', 24 * 60 * 60, 'NX')
    if (inserted !== 'OK') {
      throw new AppError(ERROR_CODES.CONFLICT, 'Request with this Idempotency-Key is already processing', 409)
    }

    request.idempotency = {
      key: keyHeader,
      cacheKey: responseKey,
      lockKey,
      state: 'registered',
    }
  })

  fastify.addHook('onSend', async (request, reply, payload) => {
    if (request.idempotency === undefined || reply.statusCode >= 500) {
      return payload
    }

    const contentType = reply.getHeader('content-type')
    const record: CachedResponse = {
      statusCode: reply.statusCode,
      contentType: typeof contentType === 'string' ? contentType : 'application/json; charset=utf-8',
      payload: payloadToString(payload),
    }

    await fastify.redis.set(request.idempotency.cacheKey, JSON.stringify(record), 'EX', 24 * 60 * 60)
    return payload
  })

  fastify.addHook('onResponse', async (request, reply) => {
    if (request.idempotency?.lockKey) {
      await fastify.redis.del(request.idempotency.lockKey).catch((error: unknown) => {
        fastify.log.error({ err: error, lockKey: request.idempotency?.lockKey }, 'failed to delete idempotency lock key')
      })
    }
  })
  done()
}, {
  name: '08-idempotency',
  dependencies: ['05-redis', '07-auth'],
})
