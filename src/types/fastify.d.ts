import type { PrismaClient } from '../generated/prisma/client'
import type { Redis } from 'ioredis'
import type { CacheManager } from '../core/cache/cache-manager'
import type { IEventBus } from '../core/events/event-bus.interface'
import type { QueueRegistry } from '../core/queue/queues'
import type { AuthenticatedUser } from './auth'

declare module 'fastify' {
  interface FastifyInstance {
    db: {
      readonly primary: PrismaClient
      readonly read: PrismaClient
    }
    redis: Redis
    cache: CacheManager
    eventBus: IEventBus
    queues: QueueRegistry
  }

  interface FastifyRequest {
    requestId: string
    user?: AuthenticatedUser
    rawBody?: Buffer
    idempotency?: {
      readonly key: string
      readonly cacheKey: string
      readonly state: 'registered'
    }
  }

  interface FastifyContextConfig {
    financialMutation?: boolean
    audit?: {
      readonly action: string
      readonly resourceType: string
    }
  }
}
