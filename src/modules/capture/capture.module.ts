import fp from 'fastify-plugin'
import type { AppFastifyPluginAsync } from '../../types/fastify'
import { registerManualCaptureRoutes } from './manual/routes/manual-capture.routes'
import { registerEmailCaptureRoutes } from './email/routes/email-capture.routes'
import { PrismaAccountRepository } from '../accounts/repositories/account.repo'
import { PrismaTransactionRepository } from '../transactions/repositories/transaction.repo'
import { PrismaCategorizationRepository } from '../transactions/repositories/categorization.repo'
import { PrismaEmailAccessLogRepository } from './email/repositories/email-access-log.repo'
import { PrismaGmailConnectionRepository } from './email/repositories/gmail-connection.repo'
import { OAuthService } from './email/services/oauth.service'
import { FetchService } from './email/services/fetch.service'
import { SafetyFilterService } from './email/services/safety-filter.service'
import { ParserRegistryService } from './email/services/parser-registry.service'
import { AIUniversalParser } from './email/parsers/ai-universal.parser'
import { DiscoveryService } from './email/services/discovery.service'
import { NormalizerService } from '../transactions/services/normalizer.service'
import { CategorizerService } from '../transactions/services/categorizer.service'
import { ReconciliationService } from '../transactions/services/reconciliation.service'
import { EmailIngestWorker } from './email/workers/email-ingest.worker'
import { WatchRenewalWorker } from './email/workers/watch-renewal.worker'
import { createBullMqConnectionOptions } from '../../core/queue/client'
import { WatchService } from './email/services/watch.service'
import { TransferMatcherService } from '../transactions/services/transfer-matcher.service'
import { PrismaTransferRepository } from '../transactions/repositories/transfer.repo'

// Concrete Bank Parsers
import { AccessParser } from './email/parsers/access.parser'

const captureModule: AppFastifyPluginAsync = async (fastify) => {
  const logger = fastify.log

  // 1. Fetch categories to build name -> id map for AI categorization
  const categories = await fastify.db.primary.category.findMany({
    select: { id: true, name: true },
  })

  const categoriesMap = new Map<string, string>(
    categories.map((c) => [c.name.toLowerCase().trim(), c.id]),
  )

  // 2. Register routes
  registerManualCaptureRoutes(fastify, categoriesMap)
  registerEmailCaptureRoutes(fastify)

  // 3. Initialize repositories and services
  const connection = createBullMqConnectionOptions(fastify.appConfig)

  const accountRepo = new PrismaAccountRepository(fastify.db.primary)
  const transactionRepo = new PrismaTransactionRepository(fastify.db.primary)
  const mappingRepo = new PrismaCategorizationRepository(fastify.db.primary)
  const emailAccessLogRepo = new PrismaEmailAccessLogRepository(fastify.db.primary)
  const connectionRepo = new PrismaGmailConnectionRepository(fastify.db.primary)
  const oauthService = new OAuthService(fastify.appConfig, connectionRepo, logger)
  const fetchService = new FetchService(logger)
  const safetyFilter = new SafetyFilterService()

  const parsers = [
    new AccessParser(),
  ]
  const parserRegistry = new ParserRegistryService({ parsers })

  const aiProvider = fastify.ai

  const aiUniversalParser = new AIUniversalParser({
    prisma: fastify.db.primary,
    aiProvider,
    logger,
  })

  const discoveryService = new DiscoveryService({
    captureEmailQueue: fastify.queues.captureEmail,
    logger,
  })

  const normalizer = new NormalizerService()
  const categorizer = new CategorizerService({
    mappingRepo,
    aiProvider,
    redis: fastify.redis,
    logger,
  })
  const reconciliation = new ReconciliationService({ logger })
  const transferMatcher = new TransferMatcherService({
    repo: new PrismaTransferRepository(fastify.db.primary),
    logger,
  })

  // 4. Instantiate and run workers (skipped in tests to avoid Redis connection attempts)
  if (fastify.appConfig.nodeEnv !== 'test' && fastify.runWorkers) {
    const emailIngestWorker = new EmailIngestWorker({
      connection,
      concurrency: 5,
      prisma: fastify.db.primary,
      accountRepo,
      transactionRepo,
      emailAccessLogRepo,
      connectionRepo,
      oauthService,
      fetchService,
      safetyFilter,
      parserRegistry,
      aiUniversalParser,
      discoveryService,
      normalizer,
      categorizer,
      reconciliation,
      transferMatcher,
      logger,
      captureEmailQueue: fastify.queues.captureEmail,
    })

    const watchService = new WatchService(fastify.appConfig, logger)

    const watchRenewalWorker = new WatchRenewalWorker({
      connection,
      concurrency: 1,
      prisma: fastify.db.primary,
      connectionRepo,
      oauthService,
      watchService,
      logger,
    })

    // Schedule repeatable cleanup job for raw snippets (runs daily at 02:00 UTC)
    fastify.queues.captureEmail.add(
      'cleanup-raw-snippets',
      {},
      { repeat: { pattern: '0 2 * * *' } }
    ).catch((err: unknown) => logger.error({ err }, 'Failed to schedule raw snippet cleanup cron'))

    // 5. Ensure graceful shutdown of workers on Fastify close
    fastify.addHook('onClose', async () => {
      logger.info('Stopping capture module workers...')
      await Promise.allSettled([
        emailIngestWorker.close(),
        watchRenewalWorker.close(),
      ])
      logger.info('Capture module workers stopped.')
    })
  }
}

export const capturePlugin = fp(captureModule, {
  name: 'module-capture',
  dependencies: ['04-database', '05-redis', '07-auth', '06-cache'],
})
