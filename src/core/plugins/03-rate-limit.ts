import fp from 'fastify-plugin'
import type { AppFastifyInstance, AppFastifyPluginCallback } from '../../types/fastify'
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

export const rateLimitPlugin: AppFastifyPluginCallback = fp((fastify: AppFastifyInstance, _options, done) => {
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
    const bucket = Math.floor(now / (windowSeconds * 1_000))

    // A route that sets its own limit gets its own counter.
    //
    // Previously every route shared one counter per caller while each applied
    // its OWN limit to it, which is not a rate limit so much as a race: fifteen
    // ordinary API calls left POST /v1/auth/refresh (max 20) with five before
    // it started returning 429. A client that had been using the app — which is
    // exactly the client whose token is about to expire — was therefore the
    // most likely to be refused a refresh, and being refused a refresh means
    // being signed out.
    //
    // The shared counter is kept as the default so the blanket per-caller
    // ceiling still applies to everything that has not opted out.
    const scope = routeConfig === undefined ? 'all' : (request.routeOptions?.url ?? request.url)
    const localKey = `rate:${scope}:${userOrIp}:${bucket}`

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
