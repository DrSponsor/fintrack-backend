import type { Redis } from 'ioredis'
import type { ISubscriptionRepository } from '../repositories/billing.repo'
import type { IUserRepository } from '../../auth/repositories/user.repo'
import type { PrismaClient } from '../../../generated/prisma/client'
import type { AppLogger } from '../../../core/logger'

export type GracePeriodDeps = {
  readonly subscriptionRepo: ISubscriptionRepository
  readonly userRepo: IUserRepository
  readonly prisma: PrismaClient
  readonly redis: Redis
  readonly logger: AppLogger
}

export async function runGracePeriodDowngrade(deps: GracePeriodDeps): Promise<void> {
  const now = new Date()
  const graceSubs = await deps.subscriptionRepo.findGracePeriodSubscriptions()
  const expired = graceSubs.filter((sub) => sub.gracePeriodEndsAt !== null && sub.gracePeriodEndsAt < now)

  if (expired.length === 0) {
    return
  }

  deps.logger.info({ count: expired.length }, 'grace-period: downgrading expired grace subscriptions')

  for (const sub of expired) {
    try {
      // Law 2: Use Prisma array transactions exclusively for multi-statement writes
      await deps.prisma.$transaction([
        deps.prisma.subscription.update({
          where: { id: sub.id },
          data: { status: 'EXPIRED' },
        }),
        deps.prisma.user.update({
          where: { id: sub.userId },
          data: { tier: 'FREE' },
        }),
      ])

      // Set tier-change signal in Redis
      await deps.redis.set(`tier-change:${sub.userId}`, '1', 'EX', 3600)
      deps.logger.info({ userId: sub.userId, type: 'subscription_expired' }, 'Notification sent: subscription_expired')
    } catch (err) {
      deps.logger.error({ userId: sub.userId, err }, 'grace-period: downgrade transaction failed')
    }
  }
}
