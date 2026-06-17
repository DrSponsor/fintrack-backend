import fp from 'fastify-plugin'
import type { FastifyPluginCallback } from 'fastify'
import { registerBudgetRoutes } from './routes/budget.routes'
import { BudgetAlertService } from './services/budget-alert.service'
import { PrismaBudgetRepository } from './repositories/budget.repo'
import type { AppLogger } from '../../core/logger'

const budgetsModule: FastifyPluginCallback = (fastify, _options, done) => {
  // 1. Register HTTP routes
  registerBudgetRoutes(fastify)

  // 2. Instantiate and wire BudgetAlertService to the event bus
  const budgetRepo = new PrismaBudgetRepository(fastify.db.primary)
  const budgetAlertService = new BudgetAlertService({
    budgetRepo,
    notificationsQueue: fastify.queues.notificationsPush,
    logger: fastify.log as unknown as AppLogger,
  })
  budgetAlertService.subscribe(fastify.eventBus)

  done()
}

export const budgetsPlugin = fp(budgetsModule, {
  name: 'module-budgets',
  dependencies: ['04-database', '06-cache'],
})
