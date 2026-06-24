import fp from 'fastify-plugin'
import type { FastifyPluginCallback } from 'fastify'
import { LRUCache } from 'lru-cache'
import { AppError } from '../errors/AppError'
import { ERROR_CODES } from '../errors/codes'
import { ensureRedisConnected } from '../../config/redis'

const WINDOW_SECONDS = 60
const STANDARD_LIMIT = 200
const GLOBAL_IP_LIMIT = 1_000

const localCounters = new LRUCache<string, number>({
  max: 100_000,
  ttlAutopurge: true,
})

function getLocalCount(key: string, windowSeconds: number): number {
  const count = localCounters.get(key) ?? 0
  const nextCount = count + 1
  localCounters.set(key, nextCount, { ttl: windowSeconds * 1_000 })
  return nextCount
}

function shouldSkipRateLimit(url: string): boolean {
  return url.startsWith('/health/') || url.startsWith('/metrics')
}

export const rateLimitPlugin: FastifyPluginCallback = fp((fastify, _options, done) => {
  fastify.addHook('onRequest', async (request, reply) => {
    if (shouldSkipRateLimit(request.url)) {
      return
    }

    const config = request.routeOptions?.config as unknown as Record<string, unknown> | undefined
    const routeConfig = config?.rateLimit as { window?: number; max?: number } | undefined
    const windowSeconds = routeConfig?.window ?? WINDOW_SECONDS
    const limit = routeConfig?.max ?? (request.user === undefined ? GLOBAL_IP_LIMIT : STANDARD_LIMIT)

    const now = Date.now()
    const userOrIp = request.user?.sub ?? request.ip
    const localKey = `rate:${userOrIp}:${Math.floor(now / (windowSeconds * 1_000))}`

    try {
      const redisAction = async (): Promise<number> => {
        await ensureRedisConnected(fastify.redis)
        const redisKey = `rl:${localKey}`
        const result = await fastify.redis.eval(
          `local current = redis.call('incr', KEYS[1])
           if tonumber(current) == 1 then
             redis.call('expire', KEYS[1], ARGV[1])
           end
           return current`,
          1,
          redisKey,
          windowSeconds.toString()
        )
        return Number(result)
      }

      let timeoutId: NodeJS.Timeout | undefined
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('Redis timeout')), 500)
      })

      const count = await Promise.race([redisAction(), timeoutPromise]).finally(() => {
        if (timeoutId !== undefined) {
          clearTimeout(timeoutId)
        }
      })

      if (count > limit) {
        reply.header('retry-after', windowSeconds.toString())
        throw new AppError(ERROR_CODES.RATE_LIMITED, 'Rate limit exceeded', 429)
      }
      return
    } catch (error) {
      if (error instanceof AppError) {
        throw error
      }
      fastify.log.warn({ err: error }, 'redis rate limit unavailable; using local fallback')
    }

    const localCount = getLocalCount(localKey, windowSeconds)
    if (localCount > limit) {
      reply.header('retry-after', windowSeconds.toString())
      throw new AppError(ERROR_CODES.RATE_LIMITED, 'Rate limit exceeded', 429)
    }
  })
  done()
}, {
  name: '03-rate-limit',
})
