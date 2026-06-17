import type { ConnectionOptions, Job } from 'bullmq'
import { BaseWorker } from '../../../core/queue/base-worker'
import { QUEUE_NAMES } from '../../../core/queue/queues'
import type { IAnalysisRepository } from '../repositories/analysis.repo'
import type { WeeklyReportService } from '../services/weekly-report.service'
import type { MonthlyReportService } from '../services/monthly-report.service'
import type { AppLogger } from '../../../core/logger'

export type WeeklyReportJobData = {
  readonly userId: string
  readonly weekStart: string // ISO string
}

export type MonthlyReportJobData = {
  readonly userId: string
  readonly monthStart: string // ISO string
}

export type ReportWorkerDeps = {
  readonly connection: ConnectionOptions
  readonly concurrency: number
  readonly analysisRepo: IAnalysisRepository
  readonly weeklyReportService: WeeklyReportService
  readonly monthlyReportService: MonthlyReportService
  readonly logger: AppLogger
}

export class WeeklyReportWorker extends BaseWorker<WeeklyReportJobData, void> {
  private readonly analysisRepo: IAnalysisRepository
  private readonly weeklyReportService: WeeklyReportService

  public constructor(deps: ReportWorkerDeps) {
    super({
      queueName: QUEUE_NAMES.analysisWeekly,
      connection: deps.connection,
      concurrency: deps.concurrency,
      logger: deps.logger,
      processor: async (job: Job<WeeklyReportJobData>) => {
        const { userId, weekStart } = job.data
        const weekStartDate = new Date(weekStart)
        const weekEndDate = new Date(weekStartDate)
        weekEndDate.setUTCDate(weekStartDate.getUTCDate() + 6)
        weekEndDate.setUTCHours(23, 59, 59, 999)

        deps.logger.info({ userId, weekStart }, 'Computing weekly report snapshot...')
        const data = await this.weeklyReportService.generateReport(userId, weekStartDate)
        await this.analysisRepo.upsertReport(userId, 'WEEKLY', weekStartDate, weekEndDate, data)
        deps.logger.info({ userId, weekStart }, 'Weekly report snapshot successfully computed and saved.')
      },
    })
    this.analysisRepo = deps.analysisRepo
    this.weeklyReportService = deps.weeklyReportService
  }
}

export class MonthlyReportWorker extends BaseWorker<MonthlyReportJobData, void> {
  private readonly analysisRepo: IAnalysisRepository
  private readonly monthlyReportService: MonthlyReportService

  public constructor(deps: ReportWorkerDeps) {
    super({
      queueName: QUEUE_NAMES.analysisMonthly,
      connection: deps.connection,
      concurrency: deps.concurrency,
      logger: deps.logger,
      processor: async (job: Job<MonthlyReportJobData>) => {
        const { userId, monthStart } = job.data
        const monthStartDate = new Date(monthStart)
        const monthEndDate = new Date(Date.UTC(monthStartDate.getUTCFullYear(), monthStartDate.getUTCMonth() + 1, 0, 23, 59, 59, 999))

        deps.logger.info({ userId, monthStart }, 'Computing monthly report snapshot...')
        const data = await this.monthlyReportService.generateReport(userId, monthStartDate)
        await this.analysisRepo.upsertReport(userId, 'MONTHLY', monthStartDate, monthEndDate, data)
        deps.logger.info({ userId, monthStart }, 'Monthly report snapshot successfully computed and saved.')
      },
    })
    this.analysisRepo = deps.analysisRepo
    this.monthlyReportService = deps.monthlyReportService
  }
}
