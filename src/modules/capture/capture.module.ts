import fp from 'fastify-plugin'
import type { FastifyPluginAsync } from 'fastify'
import { registerManualCaptureRoutes } from './manual/routes/manual-capture.routes'
import { registerEmailCaptureRoutes } from './email/routes/email-capture.routes'
import { PrismaAccountRepository } from '../accounts/repositories/account.repo'
import { PrismaTransactionRepository } from '../transactions/repositories/transaction.repo'
import { PrismaCategorizationRepository } from '../transactions/repositories/categorization.repo'
import { OAuthService } from './email/services/oauth.service'
import { FetchService } from './email/services/fetch.service'
import { SafetyFilterService } from './email/services/safety-filter.service'
import { ParserRegistryService } from './email/services/parser-registry.service'
import { AIUniversalParser } from './email/parsers/ai-universal.parser'
import { DiscoveryService } from './email/services/discovery.service'
import { NormalizerService } from '../transactions/services/normalizer.service'
import { CategorizerService } from '../transactions/services/categorizer.service'
import { DeduplicatorService } from '../transactions/services/deduplicator.service'
import { EmailIngestWorker } from './email/workers/email-ingest.worker'
import { WatchRenewalWorker } from './email/workers/watch-renewal.worker'
import { createBullMqConnectionOptions } from '../../core/queue/client'
import { DeepSeekProvider } from '../../core/ai/deepseek.provider'
import { WatchService } from './email/services/watch.service'
import type { AppLogger } from '../../core/logger'

// Concrete Bank Parsers
import { GtbParser } from './email/parsers/gtb.parser'
import { AccessParser } from './email/parsers/access.parser'
import { ZenithParser } from './email/parsers/zenith.parser'
import { UbaParser } from './email/parsers/uba.parser'
import { FirstBankParser } from './email/parsers/firstbank.parser'
import { KudaParser } from './email/parsers/kuda.parser'
import { OpayParser } from './email/parsers/opay.parser'
import { MoniepointParser } from './email/parsers/moniepoint.parser'
import { WemaParser } from './email/parsers/wema.parser'
import { FidelityParser } from './email/parsers/fidelity.parser'

const captureModule: FastifyPluginAsync = async (fastify) => {
  const logger = fastify.log as unknown as AppLogger

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
  const oauthService = new OAuthService(fastify.appConfig, accountRepo, logger)
  const fetchService = new FetchService(logger)
  const safetyFilter = new SafetyFilterService()

  const parsers = [
    new GtbParser(),
    new AccessParser(),
    new ZenithParser(),
    new UbaParser(),
    new FirstBankParser(),
    new KudaParser(),
    new OpayParser(),
    new MoniepointParser(),
    new WemaParser(),
    new FidelityParser(),
  ]
  const parserRegistry = new ParserRegistryService({ parsers })

  const aiProvider = new DeepSeekProvider({
    apiKey: fastify.appConfig.deepseekApiKey ?? '',
    categoriesMap,
  })

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
  const deduplicator = new DeduplicatorService({
    redis: fastify.redis,
  })

  // 4. Instantiate and run workers (skipped in tests to avoid Redis connection attempts)
  if (fastify.appConfig.nodeEnv !== 'test') {
    const emailIngestWorker = new EmailIngestWorker({
      connection,
      concurrency: 5,
      prisma: fastify.db.primary,
      accountRepo,
      transactionRepo,
      oauthService,
      fetchService,
      safetyFilter,
      parserRegistry,
      aiUniversalParser,
      discoveryService,
      normalizer,
      categorizer,
      deduplicator,
      logger,
      captureEmailQueue: fastify.queues.captureEmail,
    })

    const watchService = new WatchService(fastify.appConfig, logger)

    const watchRenewalWorker = new WatchRenewalWorker({
      connection,
      concurrency: 1,
      prisma: fastify.db.primary,
      accountRepo,
      oauthService,
      watchService,
      logger,
    })

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
