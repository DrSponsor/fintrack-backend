import fp from 'fastify-plugin'
import type { FastifyPluginCallback } from 'fastify'
import { registerCheckoutRoute } from './routes/checkout.route'
import { registerCancelRoute } from './routes/cancel.route'
import { registerSubscriptionRoute } from './routes/subscription.route'
import { registerWebhookRoute } from './routes/webhook.route'
import { PaystackProvider } from './providers/paystack.provider'
import { PrismaBillingRepository, PrismaSubscriptionRepository } from './repositories/billing.repo'
import { PrismaUserRepository } from '../auth/repositories/user.repo'
import { SubscriptionService } from './services/subscription.service'
import { BillingService } from './services/billing.service'
import { BillingWebhookWorker } from './workers/webhook.worker'
import { createBullMqConnectionOptions } from '../../core/queue/client'
import type { AppLogger } from '../../core/logger'

// Note: Ensure correct relative paths: routes/checkout.route, etc.
const billingModule: FastifyPluginCallback = (fastify, _options, done) => {
  const logger = fastify.log as unknown as AppLogger
  const appConfig = fastify.appConfig

  // 1. Instantiate Core billing dependencies
  // In development/test, paystackSecretKey might fall back to dummy, handled inside PaystackProvider
  const paystackSecretKey = appConfig.paystackSecretKey || ''
  const billingProvider = new PaystackProvider(paystackSecretKey)

  const billingRepo = new PrismaBillingRepository(fastify.db.primary)
  const subscriptionRepo = new PrismaSubscriptionRepository(fastify.db.primary)
  const userRepo = new PrismaUserRepository(fastify.db.primary)

  const subscriptionService = new SubscriptionService({
    subscriptionRepo,
    userRepo,
    redis: fastify.redis,
  })

  const billingService = new BillingService({
    billingProvider,
    subscriptionRepo,
    userRepo,
  })

  // 2. Register HTTP routes
  registerCheckoutRoute(fastify, { billingService, appConfig })
  registerCancelRoute(fastify, { subscriptionRepo, billingProvider })
  registerSubscriptionRoute(fastify, { subscriptionRepo })
  registerWebhookRoute(fastify, { billingProvider, billingRepo })

  // 3. Register BullMQ workers (skipped in test environment to avoid connection noise)
  if (appConfig.nodeEnv !== 'test' && fastify.runWorkers) {
    const worker = new BillingWebhookWorker({
      connection: createBullMqConnectionOptions(appConfig),
      concurrency: 2,
      logger,
      billingRepo,
      subscriptionRepo,
      userRepo,
      subscriptionService,
      billingProvider,
      prisma: fastify.db.primary,
      redis: fastify.redis,
      queues: fastify.queues,
    })

    // Schedule repeatable cron checks:
    // Sync all subscriptions daily at 3:00 AM
    fastify.queues.billingWebhooks.add(
      'sync-subscriptions',
      {},
      { repeat: { pattern: '0 3 * * *' } }
    ).catch((err: unknown) => logger.error({ err }, 'Failed to schedule subscription sync cron'))

    // Downgrade grace period expired subscriptions hourly
    fastify.queues.billingWebhooks.add(
      'downgrade-grace-period',
      {},
      { repeat: { pattern: '0 * * * *' } }
    ).catch((err: unknown) => logger.error({ err }, 'Failed to schedule grace period cron'))

    // Graceful shutdown registration
    fastify.addHook('onClose', async () => {
      logger.info('Stopping billing workers...')
      await worker.close()
      logger.info('Billing workers stopped.')
    })
  }

  done()
}

export const billingModuleName = 'billing' as const

export const billingPlugin = fp(billingModule, {
  name: 'module-billing',
  dependencies: ['04-database', '05-redis'],
})
