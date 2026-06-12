import fp from 'fastify-plugin'
import type { FastifyInstance, FastifyPluginCallback } from 'fastify'
import type { AppConfig } from '../../config'
import { CacheManager } from '../cache/cache-manager'
import { eventBus as defaultEventBus } from '../events/bus'
import type { IEventBus } from '../events/event-bus.interface'
import { createBullMqConnectionOptions } from '../queue/client'
import { createQueueRegistry } from '../queue/queues'
import type { QueueRegistry } from '../queue/queues'

export type CachePluginOptions = {
  readonly appConfig: AppConfig
  readonly eventBus?: IEventBus
  readonly queues?: QueueRegistry
}

export const cachePlugin = fp((fastify: FastifyInstance<any, any, any, any, any>, options: CachePluginOptions, done) => {
  fastify.decorate('cache', new CacheManager(fastify.redis))
  fastify.decorate('eventBus', options.eventBus ?? defaultEventBus)

  const queues = options.queues ?? createQueueRegistry(createBullMqConnectionOptions(options.appConfig))
  fastify.decorate('queues', queues)
  fastify.addHook('onClose', async () => {
    await queues.close()
  })
  done()
}, {
  name: '06-cache',
  dependencies: ['05-redis'],
})
