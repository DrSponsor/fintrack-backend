import type { Redis } from 'ioredis'
import { sha256Hex } from '../../../core/crypto/hashing'

export type DeduplicatorServiceDeps = {
  readonly redis: Redis
}

export class DeduplicatorService {
  private readonly redis: Redis

  public constructor(deps: DeduplicatorServiceDeps) {
    this.redis = deps.redis
  }

  /**
   * Computes the SHA256 deduplication hash based on:
   * accountLast4 + amountKobo + date(YYYY-MM-DD) + 5-minute unixtime bucket.
   */
  public getTransactionHash(
    accountLast4: string,
    amountKobo: bigint,
    transactionDate: Date,
  ): string {
    const dateStr = transactionDate.toISOString().split('T')[0] ?? ''
    const bucket = Math.floor(transactionDate.getTime() / (300 * 1000))
    const rawString = `${accountLast4}:${amountKobo.toString()}:${dateStr}:${bucket}`
    return sha256Hex(rawString)
  }

  /**
   * Checks if a duplicate transaction exists in Redis.
   * Returns the cached transactionId if found, null otherwise.
   */
  public async findDuplicate(hash: string): Promise<string | null> {
    const key = `dedup:hash:${hash}`
    return this.redis.get(key)
  }

  /**
   * Caches the transaction hash in Redis for a 6-hour window.
   */
  public async trackTransaction(hash: string, transactionId: string): Promise<void> {
    const key = `dedup:hash:${hash}`
    await this.redis.set(key, transactionId, 'EX', 6 * 60 * 60)
  }
}
