import fp from 'fastify-plugin'
import type { FastifyPluginCallback } from 'fastify'
import { AppError } from '../errors/AppError'
import { ERROR_CODES } from '../errors/codes'
import { ensureRedisConnected } from '../../config/redis'

const WINDOW_SECONDS = 60
const STANDARD_LIMIT = 200
const GLOBAL_IP_LIMIT = 1_000
const localCounters = new Map<string, { count: number; resetAt: number }>()

function getLocalCount(key: string, now: number): number {
  const existing = localCounters.get(key)
  if (existing === undefined || existing.resetAt <= now) {
    localCounters.set(key, { count: 1, resetAt: now + WINDOW_SECONDS * 1_000 })
    return 1
  }
  existing.count += 1
  return existing.count
}

function shouldSkipRateLimit(url: string): boolean {
  return url.startsWith('/health/') || url.startsWith('/metrics')
}

export const rateLimitPlugin: FastifyPluginCallback = fp((fastify, _options, done) => {
  fastify.addHook('onRequest', async (request, reply) => {
    if (shouldSkipRateLimit(request.url)) {
      return
    }

    const now = Date.now()
    const userOrIp = request.user?.sub ?? request.ip
    const limit = request.user === undefined ? GLOBAL_IP_LIMIT : STANDARD_LIMIT
    const localKey = `rate:${userOrIp}:${Math.floor(now / (WINDOW_SECONDS * 1_000))}`

    try {
      await ensureRedisConnected(fastify.redis)
      const redisKey = `rl:${localKey}`
      const count = await fastify.redis.incr(redisKey)
      if (count === 1) {
        await fastify.redis.expire(redisKey, WINDOW_SECONDS)
      }
      if (count > limit) {
        reply.header('retry-after', WINDOW_SECONDS.toString())
        throw new AppError(ERROR_CODES.RATE_LIMITED, 'Rate limit exceeded', 429)
      }
      return
    } catch (error) {
      if (error instanceof AppError) {
        throw error
      }
      fastify.log.warn({ err: error }, 'redis rate limit unavailable; using local fallback')
    }

    const localCount = getLocalCount(localKey, now)
    if (localCount > limit) {
      reply.header('retry-after', WINDOW_SECONDS.toString())
      throw new AppError(ERROR_CODES.RATE_LIMITED, 'Rate limit exceeded', 429)
    }
  })
  done()
}, {
  name: '03-rate-limit',
})
