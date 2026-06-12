import { QueueEvents } from 'bullmq'
import type { ConnectionOptions } from 'bullmq'
import type { AppConfig } from '../../config'

export function createBullMqConnectionOptions(appConfig: AppConfig): ConnectionOptions {
  const url = new URL(appConfig.redisUrl)

  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    maxRetriesPerRequest: null,
    ...(url.password.length > 0 ? { password: decodeURIComponent(url.password) } : {}),
    ...(url.username.length > 0 ? { username: decodeURIComponent(url.username) } : {}),
  }
}

export function createQueueEvents(queueName: string, connection: ConnectionOptions): QueueEvents {
  return new QueueEvents(queueName, { connection })
}
