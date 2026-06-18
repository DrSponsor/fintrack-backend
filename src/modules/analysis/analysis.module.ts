import fp from 'fastify-plugin'
import type { FastifyPluginCallback } from 'fastify'
import { registerAnalysisRoutes } from './routes/analysis.routes'
import { PrismaAnalysisRepository } from './repositories/analysis.repo'
import { PrismaBudgetRepository } from '../budgets/repositories/budget.repo'
import { PrismaUserRepository } from '../auth/repositories/user.repo'
import { AnomalyDetectorService } from './services/anomaly-detector.service'
import { RecurringDetectorService } from './services/recurring-detector.service'
import { ForecastService } from './services/forecast.service'
import { WeeklyReportService } from './services/weekly-report.service'
import { MonthlyReportService } from './services/monthly-report.service'
import { WeeklyReportWorker, MonthlyReportWorker } from './workers/report.worker'
import type { AppLogger } from '../../core/logger'
import { createBullMqConnectionOptions } from '../../core/queue/client'

const analysisModule: FastifyPluginCallback = (fastify, _options, done) => {
  const logger = fastify.log as unknown as AppLogger

  // 1. Register HTTP routes
  registerAnalysisRoutes(fastify)

  // 2. Instantiate core services
  const analysisRepo = new PrismaAnalysisRepository(fastify.db.primary, fastify.db.read)
  const budgetRepo = new PrismaBudgetRepository(fastify.db.primary)
  const userRepo = new PrismaUserRepository(fastify.db.primary)

  const anomalyDetector = new AnomalyDetectorService()
  const recurringDetector = new RecurringDetectorService()
  const forecastService = new ForecastService()

  const aiProvider = fastify.ai

  const weeklyReportService = new WeeklyReportService({
    analysisRepo,
    budgetRepo,
    userRepo,
    anomalyDetector,
    recurringDetector,
    forecastService,
    aiProvider,
  })

  const monthlyReportService = new MonthlyReportService({
    analysisRepo,
    budgetRepo,
    userRepo,
    anomalyDetector,
    recurringDetector,
    forecastService,
    aiProvider,
  })

  // 3. Register BullMQ workers (skipped in test environment to prevent connection noise)
  const nodeEnv = fastify.appConfig.nodeEnv
  if (nodeEnv !== 'test' && fastify.runWorkers) {
    const workerDeps = {
      connection: createBullMqConnectionOptions(fastify.appConfig),
      concurrency: 2,
      analysisRepo,
      weeklyReportService,
      monthlyReportService,
      logger,
      prisma: fastify.db.primary,
      queues: fastify.queues,
    }

    const weeklyWorker = new WeeklyReportWorker(workerDeps)
    const monthlyWorker = new MonthlyReportWorker(workerDeps)

    // Schedule repeatable cron jobs for active users recomputation
    fastify.queues.analysisWeekly.add(
      'recompute-all-users-weekly',
      {},
      { repeat: { pattern: '0 22 * * 0' } }
    ).catch((err: unknown) => logger.error({ err }, 'Failed to schedule weekly report cron'))

    fastify.queues.analysisMonthly.add(
      'recompute-all-users-monthly',
      {},
      { repeat: { pattern: '1 0 1 * *' } }
    ).catch((err: unknown) => logger.error({ err }, 'Failed to schedule monthly report cron'))

    fastify.addHook('onClose', async () => {
      logger.info('Stopping report recomputation workers...')
      await Promise.all([
        weeklyWorker.close(),
        monthlyWorker.close(),
      ])
      logger.info('Report recomputation workers stopped.')
    })
  }

  // 4. Wire the transaction event listener for automatic cache invalidation and recomputation
  fastify.eventBus.subscribe('transaction.created', async (payload) => {
    try {
      // Fetch the transaction using the read replica to extract the transactionDate
      const tx = await fastify.db.read.transaction.findFirst({
        where: { id: payload.transactionId },
        select: { transactionDate: true },
      })
      if (!tx) {
        return
      }

      const txDate = tx.transactionDate

      // Resolve Monday of transaction week in UTC
      const weekStart = new Date(txDate)
      const day = weekStart.getUTCDay()
      const diff = weekStart.getUTCDate() - day + (day === 0 ? -6 : 1)
      weekStart.setUTCDate(diff)
      weekStart.setUTCHours(0, 0, 0, 0)

      // Resolve 1st of transaction month in UTC
      const monthStart = new Date(Date.UTC(txDate.getUTCFullYear(), txDate.getUTCMonth(), 1, 0, 0, 0, 0))

      // Mark database records stale (using primary DB write)
      await analysisRepo.markStale(payload.userId, 'WEEKLY', weekStart)
      await analysisRepo.markStale(payload.userId, 'MONTHLY', monthStart)

      // Delete reports from L1/L2 caches
      const cacheKeyWeekly = `report:${payload.userId}:WEEKLY:${weekStart.toISOString()}`
      const cacheKeyMonthly = `report:${payload.userId}:MONTHLY:${monthStart.toISOString()}`
      await fastify.cache.delete(cacheKeyWeekly)
      await fastify.cache.delete(cacheKeyMonthly)

      // Queue recomputation jobs with 10s delay to collapse bursts
      const weeklyJobId = `weekly:${payload.userId}:${weekStart.toISOString().split('T')[0]}`
      await fastify.queues.analysisWeekly.add(
        'compute-weekly-report',
        { userId: payload.userId, weekStart: weekStart.toISOString() },
        { jobId: weeklyJobId, delay: 10_000 },
      )

      const monthlyJobId = `monthly:${payload.userId}:${monthStart.toISOString().split('T')[0]}`
      await fastify.queues.analysisMonthly.add(
        'compute-monthly-report',
        { userId: payload.userId, monthStart: monthStart.toISOString() },
        { jobId: monthlyJobId, delay: 10_000 },
      )

      logger.info({ userId: payload.userId }, 'Marked active reports stale and scheduled recomputation.')
    } catch (error: unknown) {
      logger.error({ err: error, payload }, 'Error staleing reports on transaction.created')
    }
  })

  done()
}

export const analysisPlugin = fp(analysisModule, {
  name: 'module-analysis',
  dependencies: ['04-database', '06-cache'],
})
