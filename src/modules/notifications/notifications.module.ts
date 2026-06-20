import fp from 'fastify-plugin'
import type { FastifyPluginCallback } from 'fastify'
import { registerNotificationRoutes } from './routes/notification.routes'
import { FcmProvider } from './providers/fcm.provider'
import { PostmarkProvider } from './providers/postmark.provider'
import { PrismaNotificationRepository } from './repositories/notification.repo'
import { PrismaUserRepository } from '../auth/repositories/user.repo'
import { PrismaCategoryRepository } from '../categories/repositories/category.repo'
import { NotificationService } from './services/notification.service'
import { NotificationWorker } from './workers/notification.worker'
import { createBullMqConnectionOptions } from '../../core/queue/client'
import type { AppLogger } from '../../core/logger'

/**
 * Notifications module.
 * Instantiates dependency graph and registers HTTP route handlers and BullMQ worker.
 */
const notificationsModule: FastifyPluginCallback = (fastify, _options, done) => {
  const logger = fastify.log as unknown as AppLogger
  const appConfig = fastify.appConfig

  // 1. Instantiate external notification delivery providers
  const pushProvider = new FcmProvider(logger, {
    projectId: appConfig.firebaseProjectId,
    clientEmail: appConfig.firebaseClientEmail,
    privateKey: appConfig.firebasePrivateKey,
  })

  const emailProvider = new PostmarkProvider(
    logger,
    appConfig.emailFrom,
    appConfig.postmarkServerToken
  )

  // 2. Instantiate repository tier
  const notificationRepo = new PrismaNotificationRepository(fastify.db.primary)
  const userRepo = new PrismaUserRepository(fastify.db.primary)
  const categoryRepo = new PrismaCategoryRepository(fastify.db.primary)

  // 3. Coordinate domain layer service
  const notificationService = new NotificationService({
    notificationRepo,
    pushProvider,
    emailProvider,
    userRepo,
    categoryRepo,
    logger,
  })

  // 4. Register routing controllers/adapters
  registerNotificationRoutes(fastify)

  // 5. Initialize BullMQ background worker
  if (appConfig.nodeEnv !== 'test' && fastify.runWorkers) {
    const worker = new NotificationWorker({
      connection: createBullMqConnectionOptions(appConfig),
      concurrency: 5,
      notificationService,
      logger,
    })

    fastify.addHook('onClose', async () => {
      logger.info('Stopping notification workers...')
      await worker.close()
      logger.info('Notification workers stopped.')
    })
  }

  done()
}

export const notificationsPlugin = fp(notificationsModule, {
  name: 'module-notifications',
  dependencies: ['04-database', '05-redis', '07-auth'],
})
