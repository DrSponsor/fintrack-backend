import type { ISubscriptionRepository } from '../repositories/billing.repo'
import type { SubscriptionService } from '../services/subscription.service'
import type { IBillingProvider } from '../providers/billing-provider.interface'
import type { AppLogger } from '../../../core/logger'

export type SubscriptionSyncDeps = {
  readonly subscriptionRepo: ISubscriptionRepository
  readonly subscriptionService: SubscriptionService
  readonly billingProvider: IBillingProvider
  readonly logger: AppLogger
}

export async function runSubscriptionSync(deps: SubscriptionSyncDeps): Promise<void> {
  const active = await deps.subscriptionRepo.findActiveSubscriptions()
  deps.logger.info({ count: active.length }, 'sync: starting active subscription sync run')

  const tasks = active.map((sub) => async () => {
    try {
      const remote = await deps.billingProvider.getSubscription(sub.providerSubscriptionId)

      if (remote.status === 'cancelled' || remote.status === 'expired') {
        await deps.subscriptionService.handleCancellation(sub.userId, sub.id)
        deps.logger.warn({ userId: sub.userId }, 'sync: missed cancellation recovered')
      } else if (remote.currentPeriodEnd.getTime() !== sub.currentPeriodEnd.getTime()) {
        await deps.subscriptionRepo.updateStatus(sub.id, 'ACTIVE', {
          currentPeriodEnd: remote.currentPeriodEnd,
        })
      }
    } catch (err) {
      // Log per-subscription failure but continue the batch
      deps.logger.error({ userId: sub.userId, err }, 'sync: subscription check failed')
    }
  })

  // Concurrency limit of 10 concurrent requests
  await limitConcurrency(tasks, 10)
  deps.logger.info('sync: active subscription sync run complete')
}

async function limitConcurrency(tasks: (() => Promise<void>)[], limit: number): Promise<void> {
  const executing: Promise<void>[] = []
  for (const task of tasks) {
    const p = Promise.resolve().then(() => task())
    executing.push(p)

    // Remove completed promise from executing array
    p.then(() => {
      const idx = executing.indexOf(p)
      if (idx !== -1) {
        executing.splice(idx, 1)
      }
    }).catch(() => {})

    if (executing.length >= limit) {
      await Promise.race(executing)
    }
  }
  await Promise.all(executing)
}
