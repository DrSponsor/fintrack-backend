import { describe, expect, it } from 'vitest'
import { AnomalyDetectorService } from '../../../src/modules/analysis/services/anomaly-detector.service'
import { RecurringDetectorService } from '../../../src/modules/analysis/services/recurring-detector.service'
import { ForecastService } from '../../../src/modules/analysis/services/forecast.service'
import type { DailySpend, TransactionSummary } from '../../../src/modules/analysis/repositories/analysis.repo'

describe('Analysis Core Services', () => {
  describe('AnomalyDetectorService', () => {
    const detector = new AnomalyDetectorService()

    it('flags spends > 2x average when above 10,000 kobo', () => {
      const dailySpend: readonly DailySpend[] = [
        { date: '2026-06-01', totalSpentKobo: 5000n },
        { date: '2026-06-02', totalSpentKobo: 25000n }, // Anomaly (> 2x 10000n and > 10000n)
        { date: '2026-06-03', totalSpentKobo: 12000n },
      ]
      const rollingAverages = new Map<string, bigint>([
        ['2026-06-01', 5000n],
        ['2026-06-02', 10000n],
        ['2026-06-03', 8000n],
      ])

      const anomalies = detector.detectAnomalies(dailySpend, rollingAverages)
      expect(anomalies).toHaveLength(1)
      expect(anomalies[0]).toEqual({
        date: '2026-06-02',
        spentKobo: '25000',
        thresholdKobo: '20000',
      })
    })

    it('does not flag spends below 10,000 kobo even if they are > 2x average', () => {
      const dailySpend: readonly DailySpend[] = [
        { date: '2026-06-01', totalSpentKobo: 5000n }, // 5000 > 2x 1000, but <= 10000
      ]
      const rollingAverages = new Map<string, bigint>([
        ['2026-06-01', 1000n],
      ])

      const anomalies = detector.detectAnomalies(dailySpend, rollingAverages)
      expect(anomalies).toHaveLength(0)
    })
  })

  describe('RecurringDetectorService', () => {
    const detector = new RecurringDetectorService()

    it('detects weekly recurring transaction patterns', () => {
      const transactions: readonly TransactionSummary[] = [
        { id: '1', amountKobo: 5000n, type: 'DEBIT', merchantName: 'Netflix', categoryId: 'cat-1', transactionDate: new Date('2026-06-01T10:00:00Z') },
        { id: '2', amountKobo: 5000n, type: 'DEBIT', merchantName: 'Netflix', categoryId: 'cat-1', transactionDate: new Date('2026-06-08T10:00:00Z') },
        { id: '3', amountKobo: 5000n, type: 'DEBIT', merchantName: 'Netflix', categoryId: 'cat-1', transactionDate: new Date('2026-06-15T10:00:00Z') },
      ]

      const recurring = detector.detectRecurring(transactions)
      expect(recurring).toHaveLength(1)
      expect(recurring[0]).toEqual({
        merchantName: 'Netflix',
        amountKobo: '5000',
        frequency: 'WEEKLY',
        nextExpectedDate: '2026-06-22',
      })
    })

    it('detects monthly recurring transaction patterns', () => {
      const transactions: readonly TransactionSummary[] = [
        { id: '1', amountKobo: 15000n, type: 'DEBIT', merchantName: 'Rent', categoryId: 'cat-2', transactionDate: new Date('2026-04-01T10:00:00Z') },
        { id: '2', amountKobo: 15000n, type: 'DEBIT', merchantName: 'Rent', categoryId: 'cat-2', transactionDate: new Date('2026-05-01T10:00:00Z') },
        { id: '3', amountKobo: 15000n, type: 'DEBIT', merchantName: 'Rent', categoryId: 'cat-2', transactionDate: new Date('2026-05-31T10:00:00Z') }, // 30 days gap
      ]

      const recurring = detector.detectRecurring(transactions)
      expect(recurring).toHaveLength(1)
      expect(recurring[0]).toEqual({
        merchantName: 'Rent',
        amountKobo: '15000',
        frequency: 'MONTHLY',
        nextExpectedDate: '2026-06-30',
      })
    })

    it('ignores non-debit or insufficient occurrences', () => {
      const transactions: readonly TransactionSummary[] = [
        { id: '1', amountKobo: 15000n, type: 'CREDIT', merchantName: 'Salary', categoryId: 'cat-3', transactionDate: new Date('2026-04-01T10:00:00Z') },
        { id: '2', amountKobo: 15000n, type: 'CREDIT', merchantName: 'Salary', categoryId: 'cat-3', transactionDate: new Date('2026-05-01T10:00:00Z') },
        { id: '3', amountKobo: 15000n, type: 'CREDIT', merchantName: 'Salary', categoryId: 'cat-3', transactionDate: new Date('2026-05-31T10:00:00Z') },
      ]

      const recurring = detector.detectRecurring(transactions)
      expect(recurring).toHaveLength(0)
    })
  })

  describe('ForecastService', () => {
    const service = new ForecastService()

    it('correctly projects spending and income linearly', () => {
      const result = service.calculateForecast({
        spentKobo: 10000n,
        incomeKobo: 30000n,
        elapsedDays: 10,
        totalDays: 30,
      })

      expect(result).toEqual({
        projectedSpentKobo: '30000',
        projectedIncomeKobo: '90000',
        projectedNetKobo: '60000',
        confidenceRating: 'MEDIUM',
      })
    })

    it('sets correct confidence ratings depending on elapsed days ratio', () => {
      // ratio = 5 / 30 = 0.166 (< 0.3) -> LOW
      const lowResult = service.calculateForecast({
        spentKobo: 1000n,
        incomeKobo: 2000n,
        elapsedDays: 5,
        totalDays: 30,
      })
      expect(lowResult.confidenceRating).toBe('LOW')

      // ratio = 15 / 30 = 0.5 (>= 0.3, < 0.7) -> MEDIUM
      const medResult = service.calculateForecast({
        spentKobo: 1000n,
        incomeKobo: 2000n,
        elapsedDays: 15,
        totalDays: 30,
      })
      expect(medResult.confidenceRating).toBe('MEDIUM')

      // ratio = 25 / 30 = 0.833 (>= 0.7) -> HIGH
      const highResult = service.calculateForecast({
        spentKobo: 1000n,
        incomeKobo: 2000n,
        elapsedDays: 25,
        totalDays: 30,
      })
      expect(highResult.confidenceRating).toBe('HIGH')
    })
  })
})
