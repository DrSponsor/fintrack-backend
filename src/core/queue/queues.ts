import { Queue } from 'bullmq'
import type { ConnectionOptions } from 'bullmq'

export const QUEUE_NAMES = {
  captureEmail: 'capture.email',
  captureManual: 'capture.manual',
  analysisWeekly: 'analysis.weekly',
  analysisMonthly: 'analysis.monthly',
  notificationsPush: 'notifications.push',
  watchRenewal: 'watch.renewal',
  billingWebhooks: 'billing.webhooks',
} as const

export type QueueName = typeof QUEUE_NAMES[keyof typeof QUEUE_NAMES]

export type QueueRegistry = {
  readonly captureEmail: Queue
  readonly captureManual: Queue
  readonly analysisWeekly: Queue
  readonly analysisMonthly: Queue
  readonly notificationsPush: Queue
  readonly watchRenewal: Queue
  readonly billingWebhooks: Queue
  close(): Promise<void>
}

export function createQueueRegistry(connection: ConnectionOptions): QueueRegistry {
  const captureEmail = new Queue(QUEUE_NAMES.captureEmail, {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 1_000 },
      removeOnComplete: 1_000,
      removeOnFail: false,
    },
  })

  const captureManual = new Queue(QUEUE_NAMES.captureManual, {
    connection,
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: 1_000,
      removeOnFail: false,
    },
  })

  const analysisWeekly = new Queue(QUEUE_NAMES.analysisWeekly, {
    connection,
    defaultJobOptions: {
      attempts: 2,
      backoff: { type: 'fixed', delay: 30_000 },
      removeOnComplete: 1_000,
      removeOnFail: false,
    },
  })

  const analysisMonthly = new Queue(QUEUE_NAMES.analysisMonthly, {
    connection,
    defaultJobOptions: {
      attempts: 2,
      backoff: { type: 'fixed', delay: 30_000 },
      removeOnComplete: 1_000,
      removeOnFail: false,
    },
  })

  const notificationsPush = new Queue(QUEUE_NAMES.notificationsPush, {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'fixed', delay: 5_000 },
      removeOnComplete: 1_000,
      removeOnFail: false,
    },
  })

  const watchRenewal = new Queue(QUEUE_NAMES.watchRenewal, {
    connection,
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: 'fixed', delay: 30 * 60 * 1_000 },
      removeOnComplete: 1_000,
      removeOnFail: false,
    },
  })

  const billingWebhooks = new Queue(QUEUE_NAMES.billingWebhooks, {
    connection,
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: 1_000,
      removeOnFail: false,
    },
  })

  return {
    captureEmail,
    captureManual,
    analysisWeekly,
    analysisMonthly,
    notificationsPush,
    watchRenewal,
    billingWebhooks,
    async close(): Promise<void> {
      await Promise.all([
        captureEmail.close(),
        captureManual.close(),
        analysisWeekly.close(),
        analysisMonthly.close(),
        notificationsPush.close(),
        watchRenewal.close(),
        billingWebhooks.close(),
      ])
    },
  }
}
