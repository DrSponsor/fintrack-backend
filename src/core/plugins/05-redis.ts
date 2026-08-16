import fp from 'fastify-plugin'
import type { AppFastifyInstance } from '../../types/fastify'
import type { AppConfig } from '../../config'
import { createRedisClient } from '../../config/redis'
import type { RedisClient } from '../../config/redis'

export type RedisPluginOptions = {
  readonly appConfig: AppConfig
  readonly redis?: RedisClient
}

export const redisPlugin = fp((fastify: AppFastifyInstance, options: RedisPluginOptions, done) => {
  const redis = options.redis ?? createRedisClient(options.appConfig)
  fastify.decorate('redis', redis)

  fastify.addHook('onClose', async () => {
    if (redis.status !== 'end') {
      await redis.quit()
    }
  })
  done()
}, {
  name: '05-redis',
})
