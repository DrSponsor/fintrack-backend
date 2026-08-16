import fp from 'fastify-plugin'
import type { AppFastifyInstance } from '../../types/fastify'
import { OutboxWorker } from '../../workers/outbox.worker'

export const outboxPlugin = fp((fastify: AppFastifyInstance, _options, done) => {
  const logger = fastify.log
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

  // Must stay `async` even though nothing here awaits: Fastify's hook
  // dispatch only recognizes completion via a returned thenable or a `done`
  // callback — a bare synchronous function satisfies neither and the hook
  // (and therefore graceful shutdown) hangs forever. Verified directly on
  // the equivalent preHandler case in core/middleware/authenticate.ts.
  // eslint-disable-next-line @typescript-eslint/require-await
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
