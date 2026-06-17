import { describe, expect, it, vi } from 'vitest'
import { GetWeeklyReportUseCase } from '../../../src/modules/analysis/use-cases/get-weekly-report.use-case'
import { GetMonthlyReportUseCase } from '../../../src/modules/analysis/use-cases/get-monthly-report.use-case'
import type { IAnalysisRepository, ReportRecord } from '../../../src/modules/analysis/repositories/analysis.repo'
import type { CacheManager } from '../../../src/core/cache/cache-manager'
import type { Queue } from 'bullmq'

function createMockCache(value: string | null = null): CacheManager {
  return {
    get: vi.fn().mockResolvedValue(value),
    set: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    clearLocal: vi.fn(),
  } as unknown as CacheManager
}

function createMockQueue(): Queue {
  return {
    add: vi.fn().mockResolvedValue({ id: 'job-1' }),
  } as unknown as Queue
}

function createMockAnalysisRepo(report: ReportRecord | null = null): IAnalysisRepository {
  return {
    getReport: vi.fn().mockResolvedValue(report),
    upsertReport: vi.fn().mockResolvedValue(undefined),
    markStale: vi.fn().mockResolvedValue(undefined),
    getTransactionsForPeriod: vi.fn().mockResolvedValue([]),
    getCategoryTotals: vi.fn().mockResolvedValue([]),
    getDailySpend: vi.fn().mockResolvedValue([]),
    getRolling30DayAverage: vi.fn().mockResolvedValue(0n),
  }
}

describe('Report Use Cases', () => {
  describe('GetWeeklyReportUseCase', () => {
    it('returns cached report directly from L1/L2 cache', async () => {
      const report: ReportRecord = {
        id: 'r-1',
        userId: 'user-1',
        periodType: 'WEEKLY',
        periodStart: new Date('2026-06-01T00:00:00Z'),
        periodEnd: new Date('2026-06-07T23:59:59Z'),
        isStale: false,
        schemaVersion: 1,
        data: { test: true },
        generatedAt: new Date(),
      }
      const cache = createMockCache(JSON.stringify(report))
      const analysisRepo = createMockAnalysisRepo()
      const queue = createMockQueue()
      const useCase = new GetWeeklyReportUseCase({ analysisRepo, cache, weeklyQueue: queue })

      const result = await useCase.execute('user-1', new Date('2026-06-01T00:00:00Z'))

      expect(result.type).toBe('FOUND')
      if (result.type === 'FOUND') {
        expect(result.report.id).toBe(report.id)
        expect(result.report.data).toEqual(report.data)
      }
      expect(cache.get).toHaveBeenCalledOnce()
      expect(analysisRepo.getReport).not.toHaveBeenCalled()
      expect(queue.add).not.toHaveBeenCalled()
    })

    it('falls back to L3 database replica on cache miss and populates L1/L2', async () => {
      const report: ReportRecord = {
        id: 'r-1',
        userId: 'user-1',
        periodType: 'WEEKLY',
        periodStart: new Date('2026-06-01T00:00:00Z'),
        periodEnd: new Date('2026-06-07T23:59:59Z'),
        isStale: false,
        schemaVersion: 1,
        data: { test: true },
        generatedAt: new Date(),
      }
      const cache = createMockCache(null)
      const analysisRepo = createMockAnalysisRepo(report)
      const queue = createMockQueue()
      const useCase = new GetWeeklyReportUseCase({ analysisRepo, cache, weeklyQueue: queue })

      const result = await useCase.execute('user-1', new Date('2026-06-01T00:00:00Z'))

      expect(result.type).toBe('FOUND')
      expect(cache.get).toHaveBeenCalledOnce()
      expect(analysisRepo.getReport).toHaveBeenCalledOnce()
      expect(cache.set).toHaveBeenCalledOnce()
      expect(queue.add).not.toHaveBeenCalled()
    })

    it('queues a recomputation job and returns QUEUED if report is stale or missing', async () => {
      const cache = createMockCache(null)
      const analysisRepo = createMockAnalysisRepo(null) // Miss in DB
      const queue = createMockQueue()
      const useCase = new GetWeeklyReportUseCase({ analysisRepo, cache, weeklyQueue: queue })

      const result = await useCase.execute('user-1', new Date('2026-06-01T00:00:00Z'))

      expect(result.type).toBe('QUEUED')
      if (result.type === 'QUEUED') {
        expect(result.jobId).toBe('weekly:user-1:2026-06-01')
      }
      expect(queue.add).toHaveBeenCalledOnce()
    })
  })

  describe('GetMonthlyReportUseCase', () => {
    it('returns cached report directly from cache', async () => {
      const report: ReportRecord = {
        id: 'r-2',
        userId: 'user-1',
        periodType: 'MONTHLY',
        periodStart: new Date('2026-06-01T00:00:00Z'),
        periodEnd: new Date('2026-06-30T23:59:59Z'),
        isStale: false,
        schemaVersion: 1,
        data: { test: true },
        generatedAt: new Date(),
      }
      const cache = createMockCache(JSON.stringify(report))
      const analysisRepo = createMockAnalysisRepo()
      const queue = createMockQueue()
      const useCase = new GetMonthlyReportUseCase({ analysisRepo, cache, monthlyQueue: queue })

      const result = await useCase.execute('user-1', new Date('2026-06-01T00:00:00Z'))

      expect(result.type).toBe('FOUND')
      if (result.type === 'FOUND') {
        expect(result.report.id).toBe(report.id)
      }
      expect(cache.get).toHaveBeenCalledOnce()
    })
  })
})
