import type { Queue } from 'bullmq'
import type { IEventBus } from '../../../core/events/event-bus.interface'
import type { IBudgetRepository } from '../repositories/budget.repo'
import type { AppLogger } from '../../../core/logger'

export class BudgetAlertService {
  private readonly budgetRepo: IBudgetRepository
  private readonly notificationsQueue: Queue
  private readonly logger: AppLogger

  public constructor(deps: {
    readonly budgetRepo: IBudgetRepository
    readonly notificationsQueue: Queue
    readonly logger: AppLogger
  }) {
    this.budgetRepo = deps.budgetRepo
    this.notificationsQueue = deps.notificationsQueue
    this.logger = deps.logger
  }

  public subscribe(eventBus: IEventBus): void {
    eventBus.subscribe('transaction.created', async (payload) => {
      try {
        await this.handleTransactionCreated(payload)
      } catch (error: unknown) {
        this.logger.error(
          { err: error, payload },
          'BudgetAlertService error handling transaction.created event',
        )
      }
    })
  }

  private async handleTransactionCreated(payload: {
    readonly transactionId: string
    readonly userId: string
    readonly amountKobo: string
    readonly categoryId: string
  }): Promise<void> {
    const { transactionId, userId, categoryId } = payload

    // Find all budgets matching this category and user
    const budgets = await this.budgetRepo.findByCategory(userId, categoryId)
    if (budgets.length === 0) {
      return
    }

    const referenceDate = new Date()

    for (const budget of budgets) {
      // 1. Create the alert record idempotently
      await this.budgetRepo.createAlert(transactionId, budget.id, userId)

      // 2. Fetch total spent in the category for the budget's current period
      const range = this.getPeriodRange(referenceDate, budget.periodType)
      const spent = await this.budgetRepo.getSpentKobo(userId, categoryId, range.start, range.end)
      const limit = BigInt(budget.limitKobo)

      if (spent >= limit) {
        // Queue the notification job
        await this.notificationsQueue.add(
          'budget-limit-exceeded',
          {
            userId,
            budgetId: budget.id,
            categoryId,
            spentKobo: spent.toString(),
            limitKobo: limit.toString(),
            periodType: budget.periodType,
          },
          {
            // Unique Job ID to collapse duplicate alerts for the same budget during the same period and transaction
            jobId: `budget-alert:${budget.id}:${transactionId}`,
          },
        )
        this.logger.warn(
          {
            userId,
            budgetId: budget.id,
            spentKobo: spent.toString(),
            limitKobo: limit.toString(),
          },
          'Budget limit breached. Notification queued.',
        )
      }
    }
  }

  private getPeriodRange(date: Date, periodType: 'WEEKLY' | 'MONTHLY'): { start: Date; end: Date } {
    if (periodType === 'WEEKLY') {
      const start = new Date(date)
      const day = start.getUTCDay()
      const diff = start.getUTCDate() - day + (day === 0 ? -6 : 1) // Monday
      start.setUTCDate(diff)
      start.setUTCHours(0, 0, 0, 0)

      const end = new Date(start)
      end.setUTCDate(start.getUTCDate() + 6)
      end.setUTCHours(23, 59, 59, 999)
      return { start, end }
    } else {
      const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1, 0, 0, 0, 0))
      const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0, 23, 59, 59, 999))
      return { start, end }
    }
  }
}
