import { LRUCache } from 'lru-cache'
import type { Redis } from 'ioredis'

export type CacheSetOptions = {
  readonly ttlSeconds: number
}

export class CacheManager {
  private readonly l1: LRUCache<string, string>

  public constructor(private readonly redis: Redis, maxEntries = 5_000) {
    this.l1 = new LRUCache<string, string>({
      max: maxEntries,
      ttlAutopurge: true,
    })
  }

  public async get(key: string): Promise<string | null> {
    const local = this.l1.get(key)
    if (local !== undefined) {
      return local
    }

    if (this.redis.status === 'wait') {
      return null
    }

    const remote = await this.redis.get(key)
    if (remote !== null) {
      this.l1.set(key, remote, { ttl: 30_000 })
    }
    return remote
  }

  public async set(key: string, value: string, options: CacheSetOptions): Promise<void> {
    this.l1.set(key, value, { ttl: Math.min(options.ttlSeconds * 1_000, 30_000) })
    if (this.redis.status === 'wait') {
      return
    }
    await this.redis.set(key, value, 'EX', options.ttlSeconds)
  }

  public async delete(key: string): Promise<void> {
    this.l1.delete(key)
    if (this.redis.status === 'wait') {
      return
    }
    await this.redis.del(key)
  }

  public clearLocal(): void {
    this.l1.clear()
  }
}
