import Redis from 'ioredis'
import type { AppConfig } from './index'

export type RedisClient = Redis

export function createRedisClient(appConfig: AppConfig): RedisClient {
  return new Redis(appConfig.redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
  })
}

export async function ensureRedisConnected(redis: RedisClient): Promise<void> {
  if (redis.status === 'wait') {
    await redis.connect()
    return
  }
  if (redis.status === 'end') {
    throw new Error('Redis connection is closed')
  }
}

export async function checkRedis(redis: RedisClient): Promise<void> {
  await ensureRedisConnected(redis)
  const response = await redis.ping()
  if (response !== 'PONG') {
    throw new Error('Redis ping did not return PONG')
  }
}
