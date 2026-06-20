import { randomUUID } from 'node:crypto'
import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import type { Redis } from 'ioredis'
import { loadConfig } from './config'
import type { AppConfig } from './config'
import type { DatabaseClients } from './config/database'
import { createLogger } from './core/logger'
import { successEnvelope } from './core/http/envelope'
import { httpRequestDurationSeconds, httpRequestsTotal } from './core/observability/metrics'
import { requestIdPlugin } from './core/plugins/01-request-id'
import fastifyCookie from '@fastify/cookie'
import { securityPlugin } from './core/plugins/02-security'
import { rateLimitPlugin } from './core/plugins/03-rate-limit'
import { databasePlugin } from './core/plugins/04-database'
import { redisPlugin } from './core/plugins/05-redis'
import { aiPlugin } from './core/plugins/05-ai'
import { cachePlugin } from './core/plugins/06-cache'
import { authPlugin as jwtAuthPlugin } from './core/plugins/07-auth'
import { authPlugin as authModulePlugin } from './modules/auth/auth.module'
import { usersPlugin } from './modules/users/users.module'
import { accountsPlugin } from './modules/accounts/accounts.module'
import { categoriesPlugin } from './modules/categories/categories.module'
import { transactionsPlugin } from './modules/transactions/transactions.module'
import { capturePlugin } from './modules/capture/capture.module'
import { budgetsPlugin } from './modules/budgets/budgets.module'
import { analysisPlugin } from './modules/analysis/analysis.module'
import { billingPlugin } from './modules/billing/billing.module'
import { notificationsPlugin } from './modules/notifications/notifications.module'
import { privacyPlugin } from './modules/privacy/privacy.module'
import { outboxPlugin } from './core/plugins/11-outbox'
import { idempotencyPlugin } from './core/plugins/08-idempotency'
import { auditPlugin } from './core/plugins/09-audit'
import { errorHandlerPlugin } from './core/plugins/10-error-handler'
import type { IEventBus } from './core/events/event-bus.interface'
import type { QueueRegistry } from './core/queue/queues'
import { registerHealthRoutes } from './routes/health'
import type { HealthChecks } from './routes/health'
import { registerMetricsRoute } from './routes/metrics'
import { notFound } from './core/errors/factories'

export type AppFactoryOptions = {
  readonly appConfig?: AppConfig
  readonly databaseClients?: DatabaseClients
  readonly redis?: Redis
  readonly eventBus?: IEventBus
  readonly queues?: QueueRegistry
  readonly healthChecks?: HealthChecks
  readonly runWorkers?: boolean
}

export async function buildApp(options: AppFactoryOptions = {}): Promise<FastifyInstance<any, any, any, any, any>> {
  const appConfig = options.appConfig ?? loadConfig()
  const logger = createLogger(appConfig)

  const fastify = Fastify({
    loggerInstance: logger,
    genReqId: (request) => {
      const requestId = request.headers['x-request-id']
      return typeof requestId === 'string' && requestId.length > 0 ? requestId : randomUUID()
    },
  })

  fastify.addHook('onResponse', (request, reply, done) => {
    const route = request.routeOptions.url ?? request.url
    const labels = {
      method: request.method,
      route,
      status: String(reply.statusCode),
    }
    httpRequestsTotal.inc(labels)
    httpRequestDurationSeconds.observe(labels, reply.elapsedTime / 1_000)
    done()
  })

  // Make config available to all modules via Fastify's DI chain.
  // Modules access it as fastify.appConfig — never process.env directly.
  fastify.decorate('appConfig', appConfig)
  fastify.decorate('runWorkers', options.runWorkers ?? false)

  await fastify.register(requestIdPlugin)
  await fastify.register(fastifyCookie, {
    secret: appConfig.jwtPrivateKeyPem || 'fintrack-cookie-secret-fallback',
  })
  await fastify.register(securityPlugin, { appConfig })
  await fastify.register(rateLimitPlugin)
  await fastify.register(databasePlugin, {
    appConfig,
    ...(options.databaseClients ? { clients: options.databaseClients } : {}),
  })
  await fastify.register(redisPlugin, {
    appConfig,
    ...(options.redis ? { redis: options.redis } : {}),
  })
  await fastify.register(aiPlugin)
  await fastify.register(cachePlugin, {
    appConfig,
    ...(options.eventBus ? { eventBus: options.eventBus } : {}),
    ...(options.queues ? { queues: options.queues } : {}),
  })
  await fastify.register(jwtAuthPlugin, { appConfig })
  await fastify.register(idempotencyPlugin)
  await fastify.register(auditPlugin)
  await fastify.register(errorHandlerPlugin)

  // ── Module registration ──────────────────────────────────────
  await fastify.register(authModulePlugin)
  await fastify.register(usersPlugin)
  await fastify.register(accountsPlugin)
  await fastify.register(categoriesPlugin)
  await fastify.register(transactionsPlugin)
  await fastify.register(capturePlugin)
  await fastify.register(outboxPlugin)
  await fastify.register(budgetsPlugin)
  await fastify.register(analysisPlugin)
  await fastify.register(billingPlugin)
  await fastify.register(notificationsPlugin)
  await fastify.register(privacyPlugin)

  // ── Infrastructure routes ───────────────────────────────────
  registerHealthRoutes(fastify, options.healthChecks)
  registerMetricsRoute(fastify)

  fastify.get('/v1', {
    schema: {
      response: {
        200: {
          type: 'object',
          additionalProperties: false,
          required: ['success', 'data', 'requestId'],
          properties: {
            success: { type: 'boolean', const: true },
            data: {
              type: 'object',
              additionalProperties: false,
              required: ['name', 'version'],
              properties: {
                name: { type: 'string' },
                version: { type: 'string' },
              },
            },
            requestId: { type: 'string' },
          },
        },
      },
    },
  }, (request) => successEnvelope({ name: 'FinTrack API', version: 'v1' }, request.requestId))

  fastify.setNotFoundHandler((request) => {
    request.log.warn({ method: request.method, url: request.url }, 'route not found')
    throw notFound()
  })

  return fastify
}
