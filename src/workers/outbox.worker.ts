import { randomUUID } from 'node:crypto'
import type { PrismaClient } from '../generated/prisma/client'
import type { AppLogger } from '../core/logger'
import type { IEventBus } from '../core/events/event-bus.interface'
import type { Redis } from 'ioredis'
import { isAppEventName, parseEventPayload } from '../core/events/events'

export type OutboxWorkerOptions = {
  readonly prisma: PrismaClient
  readonly redis: Redis
  readonly eventBus: IEventBus
  readonly logger: AppLogger
  readonly batchSize?: number
}

export class OutboxWorker {
  private readonly prisma: PrismaClient
  private readonly redis: Redis
  private readonly eventBus: IEventBus
  private readonly logger: AppLogger
  private readonly batchSize: number

  public constructor(options: OutboxWorkerOptions) {
    this.prisma = options.prisma
    this.redis = options.redis
    this.eventBus = options.eventBus
    this.logger = options.logger
    this.batchSize = options.batchSize ?? 100
  }

  public async publishPending(): Promise<number> {
    const lockKey = 'lock:outbox:publish'
    const lockValue = randomUUID()
    // Attempt to acquire lock for 10 seconds (non-blocking, NX)
    const acquired = await this.redis.set(lockKey, lockValue, 'EX', 10, 'NX')
    if (acquired !== 'OK') {
      return 0
    }

    try {
      const pending = await this.prisma.outboxEvent.findMany({
        where: {
          publishedAt: null,
          attempts: { lt: 5 },
        },
        orderBy: { createdAt: 'asc' },
        take: this.batchSize,
      })

      let published = 0

      for (const event of pending) {
        try {
          if (!isAppEventName(event.eventType)) {
            throw new Error(`Unsupported outbox event type: ${event.eventType}`)
          }

          const payload = parseEventPayload(event.eventType, event.payload)
          await this.eventBus.publish(event.eventType, payload)
          await this.prisma.outboxEvent.update({
            where: { id: event.id },
            data: { publishedAt: new Date() },
          })
          published += 1
        } catch (error) {
          this.logger.error({ err: error, outboxEventId: event.id }, 'outbox publish failed')
          await this.prisma.outboxEvent.update({
            where: { id: event.id },
            data: { attempts: { increment: 1 } },
          })
        }
      }

      return published
    } finally {
      // Lua script ensures atomic check-and-delete to avoid releasing other worker's lock
      await this.redis.eval(
        `if redis.call('get', KEYS[1]) == ARGV[1] then
           return redis.call('del', KEYS[1])
         else
           return 0
         end`,
        1,
        lockKey,
        lockValue
      )
    }
  }
}
