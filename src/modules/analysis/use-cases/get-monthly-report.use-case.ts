import type { IAnalysisRepository, ReportRecord } from '../repositories/analysis.repo'
import type { CacheManager } from '../../../core/cache/cache-manager'
import type { Queue } from 'bullmq'

export type GetMonthlyReportResult =
  | { readonly type: 'FOUND'; readonly report: ReportRecord }
  | { readonly type: 'QUEUED'; readonly jobId: string }

export class GetMonthlyReportUseCase {
  private readonly analysisRepo: IAnalysisRepository
  private readonly cache: CacheManager
  private readonly monthlyQueue: Queue
  private static readonly CURRENT_SCHEMA_VERSION = 1

  public constructor(deps: {
    readonly analysisRepo: IAnalysisRepository
    readonly cache: CacheManager
    readonly monthlyQueue: Queue
  }) {
    this.analysisRepo = deps.analysisRepo
    this.cache = deps.cache
    this.monthlyQueue = deps.monthlyQueue
  }

  public async execute(userId: string, monthStart: Date): Promise<GetMonthlyReportResult> {
    const periodStart = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth(), 1, 0, 0, 0, 0))

    const cacheKey = `report:${userId}:MONTHLY:${periodStart.toISOString()}`

    // 1. Try L1/L2 cache
    const cachedStr = await this.cache.get(cacheKey)
    if (cachedStr) {
      try {
        const cachedReport = JSON.parse(cachedStr)
        if (!cachedReport.isStale && cachedReport.schemaVersion === GetMonthlyReportUseCase.CURRENT_SCHEMA_VERSION) {
          return {
            type: 'FOUND',
            report: {
              ...cachedReport,
              periodStart: new Date(cachedReport.periodStart),
              periodEnd: new Date(cachedReport.periodEnd),
              generatedAt: new Date(cachedReport.generatedAt),
            },
          }
        }
      } catch {
        // Fall through to DB on parse failure
      }
    }

    // 2. Try L3 cache (DB read replica)
    const dbReport = await this.analysisRepo.getReport(userId, 'MONTHLY', periodStart)
    if (dbReport) {
      if (!dbReport.isStale && dbReport.schemaVersion === GetMonthlyReportUseCase.CURRENT_SCHEMA_VERSION) {
        await this.cache.set(cacheKey, JSON.stringify(dbReport), { ttlSeconds: 300 })
        return { type: 'FOUND', report: dbReport }
      }
    }

    // 3. Miss or stale -> Queue calculation job with a 10s delay to collapse bursts
    const jobId = `monthly:${userId}:${periodStart.toISOString().split('T')[0]}`
    await this.monthlyQueue.add(
      'compute-monthly-report',
      { userId, monthStart: periodStart.toISOString() },
      { jobId, delay: 10_000 },
    )

    return { type: 'QUEUED', jobId }
  }
}
