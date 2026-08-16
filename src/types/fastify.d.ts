import type {
  FastifyInstance,
  FastifyPluginCallback,
  FastifyPluginAsync,
  FastifyPluginOptions,
  FastifyTypeProviderDefault,
  RawServerDefault,
} from 'fastify'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { PrismaClient } from '../generated/prisma/client'
import type { Redis } from 'ioredis'
import type { CacheManager } from '../core/cache/cache-manager'
import type { IEventBus } from '../core/events/event-bus.interface'
import type { QueueRegistry } from '../core/queue/queues'
import type { AuthenticatedUser } from './auth'
import type { AppConfig } from '../config'
import type { AppLogger } from '../core/logger'

import type { IAIProvider } from '../core/ai/ai-provider.interface'

/**
 * `FastifyInstance` typed with this app's real logger.
 *
 * `Fastify({ loggerInstance: logger })` in `app.ts` passes a raw Pino
 * logger, so the instance it returns actually carries `AppLogger`
 * (`pino.Logger`) as its Logger generic — a stricter shape than
 * Fastify's default `FastifyBaseLogger`. Route/plugin registration
 * functions should type their `fastify` parameter with this alias
 * rather than bare `FastifyInstance`, or `fastify.log` won't line up
 * with code that expects `AppLogger` (e.g. use-case constructors).
 */
export type AppFastifyInstance = FastifyInstance<RawServerDefault, IncomingMessage, ServerResponse, AppLogger>

/** `FastifyPluginCallback`/`FastifyPluginAsync` typed with this app's real logger — see `AppFastifyInstance`. */
export type AppFastifyPluginCallback<Options extends FastifyPluginOptions = Record<never, never>> = FastifyPluginCallback<
  Options,
  RawServerDefault,
  FastifyTypeProviderDefault,
  AppLogger
>
export type AppFastifyPluginAsync<Options extends FastifyPluginOptions = Record<never, never>> = FastifyPluginAsync<
  Options,
  RawServerDefault,
  FastifyTypeProviderDefault,
  AppLogger
>

declare module 'fastify' {
  interface FastifyInstance {
    appConfig: AppConfig
    db: {
      readonly primary: PrismaClient
      readonly read: PrismaClient
    }
    redis: Redis
    cache: CacheManager
    eventBus: IEventBus
    queues: QueueRegistry
    ai: IAIProvider
    runWorkers: boolean
  }

  interface FastifyRequest {
    requestId: string
    user?: AuthenticatedUser
    rawBody?: string
    idempotency?: {
      readonly key: string
      readonly cacheKey: string
      readonly lockKey: string
      readonly state: 'registered'
    }
  }

  interface FastifyContextConfig {
    financialMutation?: boolean
    audit?: {
      readonly action: string
      readonly resourceType: string
    }
    rateLimit?: {
      readonly max?: number
      readonly window?: number
    }
  }
}
