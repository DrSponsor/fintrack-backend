import fp from 'fastify-plugin'
import type { AppFastifyPluginCallback } from '../../types/fastify'
import { registerBudgetRoutes } from './routes/budget.routes'
import { BudgetAlertService } from './services/budget-alert.service'
import { PrismaBudgetRepository } from './repositories/budget.repo'

const budgetsModule: AppFastifyPluginCallback = (fastify, _options, done) => {
  // 1. Register HTTP routes
  registerBudgetRoutes(fastify)

  // 2. Instantiate and wire BudgetAlertService to the event bus
  const budgetRepo = new PrismaBudgetRepository(fastify.db.primary)
  const budgetAlertService = new BudgetAlertService({
    budgetRepo,
    notificationsQueue: fastify.queues.notificationsPush,
    logger: fastify.log,
  })
  budgetAlertService.subscribe(fastify.eventBus)

  done()
}

export const budgetsPlugin = fp(budgetsModule, {
  name: 'module-budgets',
  dependencies: ['04-database', '06-cache'],
})
