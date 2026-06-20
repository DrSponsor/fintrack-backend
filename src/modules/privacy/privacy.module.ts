import fp from 'fastify-plugin'
import type { FastifyPluginCallback } from 'fastify'
import { registerPrivacyRoutes } from './routes/privacy.routes'
import { PrismaPrivacyRepository } from './repositories/privacy.repo'
import { PrismaUserRepository } from '../auth/repositories/user.repo'
import { PrismaAccountRepository } from '../accounts/repositories/account.repo'
import { LocalStorageProvider } from '../../core/storage/local-storage.provider'
import { InitiateDeletionUseCase } from './use-cases/initiate-deletion.use-case'
import { CancelDeletionUseCase } from './use-cases/cancel-deletion.use-case'
import { InitiateExportUseCase } from './use-cases/initiate-export.use-case'
import { AccountDeletionWorker } from './workers/account-deletion.worker'
import { DataExportWorker } from './workers/data-export.worker'
import { createBullMqConnectionOptions } from '../../core/queue/client'
import type { AppLogger } from '../../core/logger'

/**
 * Privacy module — NDPR compliance.
 *
 * Provides:
 *   - DELETE /v1/users/me/data         → Initiate account deletion (24h cooling-off)
 *   - POST   /v1/users/me/data/cancel-deletion → Cancel pending deletion
 *   - POST   /v1/users/me/data-export  → Request full data export
 *   - GET    /v1/users/me/data/deletion-status  → Check if deletion is pending
 */
const privacyModule: FastifyPluginCallback = (fastify, _options, done) => {
  const logger = fastify.log as unknown as AppLogger
  const appConfig = fastify.appConfig

  // 1. Instantiate repository tier
  const privacyRepo = new PrismaPrivacyRepository(fastify.db.primary)
  const userRepo = new PrismaUserRepository(fastify.db.primary)
  const accountRepo = new PrismaAccountRepository(fastify.db.primary)

  // 2. Instantiate storage provider (local mock for dev, swap to R2 in prod)
  const storageProvider = new LocalStorageProvider(logger)

  // 3. Instantiate use cases
  const initiateDeletionUseCase = new InitiateDeletionUseCase({
    privacyRepo,
    queues: fastify.queues,
    logger,
  })

  const cancelDeletionUseCase = new CancelDeletionUseCase({
    privacyRepo,
    queues: fastify.queues,
    logger,
  })

  const initiateExportUseCase = new InitiateExportUseCase({
    queues: fastify.queues,
    logger,
  })

  // 4. Register HTTP routes
  registerPrivacyRoutes(fastify, {
    initiateDeletionUseCase,
    cancelDeletionUseCase,
    initiateExportUseCase,
    privacyRepo,
  })

  // 5. Register BullMQ workers
  if (appConfig.nodeEnv !== 'test' && fastify.runWorkers) {
    const deletionWorker = new AccountDeletionWorker({
      connection: createBullMqConnectionOptions(appConfig),
      concurrency: 1, // Only one deletion at a time — irreversible operations
      privacyRepo,
      userRepo,
      accountRepo,
      queues: fastify.queues,
      fieldEncryptionKeyBase64: appConfig.fieldEncryptionKeyBase64,
      googleClientId: appConfig.googleClientId,
      googleClientSecret: appConfig.googleClientSecret,
      logger,
    })

    const exportWorker = new DataExportWorker({
      connection: createBullMqConnectionOptions(appConfig),
      concurrency: 2,
      privacyRepo,
      storageProvider,
      queues: fastify.queues,
      logger,
    })

    fastify.addHook('onClose', async () => {
      logger.info('Stopping privacy workers...')
      await Promise.all([deletionWorker.close(), exportWorker.close()])
      logger.info('Privacy workers stopped.')
    })
  }

  done()
}

export const privacyPlugin = fp(privacyModule, {
  name: 'module-privacy',
  dependencies: ['04-database', '05-redis', '07-auth'],
})
