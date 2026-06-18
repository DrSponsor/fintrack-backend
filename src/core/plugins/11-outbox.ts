import fp from 'fastify-plugin'
import type { FastifyInstance } from 'fastify'
import { OutboxWorker } from '../../workers/outbox.worker'
import type { AppLogger } from '../logger'

export const outboxPlugin = fp((fastify: FastifyInstance<any, any, any, any, any>, _options, done) => {
  const logger = fastify.log as unknown as AppLogger
  const nodeEnv = fastify.appConfig.nodeEnv

  if (nodeEnv === 'test' || !fastify.runWorkers) {
    done()
    return
  }

  const outboxWorker = new OutboxWorker({
    prisma: fastify.db.primary,
    redis: fastify.redis,
    eventBus: fastify.eventBus,
    logger,
  })

  const intervalId = setInterval(() => {
    outboxWorker.publishPending().catch((error: unknown) => {
      logger.error({ err: error }, 'OutboxWorker loop execution failed')
    })
  }, 5_000)

  fastify.addHook('onClose', async () => {
    logger.info('Stopping outbox worker...')
    clearInterval(intervalId)
    logger.info('Outbox worker stopped.')
  })

  done()
}, {
  name: '11-outbox',
  dependencies: ['04-database', '06-cache'],
})
