import type { PrismaClient } from '../../src/generated/prisma/client'
import type { Queue } from 'bullmq'
import type { Redis } from 'ioredis'
import { loadConfig } from '../../src/config'
import type { AppConfig } from '../../src/config'
import type { DatabaseClients } from '../../src/config/database'
import type { QueueRegistry } from '../../src/core/queue/queues'

export function createTestConfig(overrides: Partial<NodeJS.ProcessEnv> = {}): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: '3000',
    LOG_LEVEL: 'silent',
    DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/fintrack?pgbouncer=true',
    DIRECT_URL: 'postgresql://postgres:postgres@localhost:5432/fintrack',
    REDIS_URL: 'redis://localhost:6379',
    FIELD_ENCRYPTION_KEY_BASE64: Buffer.alloc(32).toString('base64'),
    ...overrides,
  })
}

export class FakeRedis {
  public status: string = 'wait'
  private readonly values = new Map<string, string>()
  private readonly counters = new Map<string, number>()
  private readonly sets = new Map<string, Set<string>>()

  public connect(): Promise<void> {
    this.status = 'ready'
    return Promise.resolve()
  }

  public quit(): Promise<'OK'> {
    this.status = 'end'
    return Promise.resolve('OK')
  }

  public async ping(): Promise<'PONG'> {
    if (this.status === 'wait') {
      await this.connect()
    }
    return 'PONG'
  }

  public get(key: string): Promise<string | null> {
    return Promise.resolve(this.values.get(key) ?? null)
  }

  public set(key: string, value: string, ...args: readonly unknown[]): Promise<'OK' | null> {
    const nx = args.some((arg) => arg === 'NX')
    if (nx && this.values.has(key)) {
      return Promise.resolve(null)
    }
    this.values.set(key, value)
    return Promise.resolve('OK')
  }

  public incr(key: string): Promise<number> {
    const next = (this.counters.get(key) ?? 0) + 1
    this.counters.set(key, next)
    return Promise.resolve(next)
  }

  public expire(_key: string, _seconds: number): Promise<number> {
    return Promise.resolve(1)
  }

  public del(key: string): Promise<number> {
    const existed = this.values.delete(key)
    return Promise.resolve(existed ? 1 : 0)
  }

  public exists(key: string): Promise<number> {
    return Promise.resolve(this.values.has(key) ? 1 : 0)
  }

  public sadd(key: string, ...members: readonly string[]): Promise<number> {
    let set = this.sets.get(key)
    if (set === undefined) {
      set = new Set()
      this.sets.set(key, set)
    }
    let added = 0
    for (const member of members) {
      if (!set.has(member)) {
        set.add(member)
        added++
      }
    }
    return Promise.resolve(added)
  }

  public srem(key: string, ...members: readonly string[]): Promise<number> {
    const set = this.sets.get(key)
    if (set === undefined) {
      return Promise.resolve(0)
    }
    let removed = 0
    for (const member of members) {
      if (set.delete(member)) {
        removed++
      }
    }
    return Promise.resolve(removed)
  }

  public smembers(key: string): Promise<readonly string[]> {
    const set = this.sets.get(key)
    if (set === undefined) {
      return Promise.resolve([])
    }
    return Promise.resolve(Array.from(set))
  }

  public ttl(_key: string): Promise<number> {
    return Promise.resolve(3600)
  }
}

function createPrismaClientStub(): PrismaClient {
  const client = {
    $queryRaw: (_strings: TemplateStringsArray): Promise<readonly { readonly ok: number }[]> => Promise.resolve([{ ok: 1 }]),
    $disconnect: (): Promise<void> => Promise.resolve(),
    auditLog: {
      create: (): Promise<unknown> => Promise.resolve({ id: 'audit' }),
    },
    subscription: {
      findUnique: (): Promise<unknown> => Promise.resolve(null),
    },
  }

  return client as unknown as PrismaClient
}

function createQueueStub(): Queue {
  const queue = {
    close: (): Promise<void> => Promise.resolve(),
  }

  return queue as unknown as Queue
}

export function createDatabaseClientsStub(): DatabaseClients {
  return {
    primary: createPrismaClientStub(),
    read: createPrismaClientStub(),
  }
}

export function createQueueRegistryStub(): QueueRegistry {
  return {
    captureEmail: createQueueStub(),
    captureManual: createQueueStub(),
    analysisWeekly: createQueueStub(),
    analysisMonthly: createQueueStub(),
    notificationsPush: createQueueStub(),
    watchRenewal: createQueueStub(),
    billingWebhooks: createQueueStub(),
    close: (): Promise<void> => Promise.resolve(),
  }
}

export function createRedisStub(): Redis {
  return new FakeRedis() as unknown as Redis
}
