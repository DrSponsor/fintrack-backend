import type { IAnalysisRepository } from '../repositories/analysis.repo'
import type { IBudgetRepository } from '../../budgets/repositories/budget.repo'
import type { IUserRepository } from '../../auth/repositories/user.repo'
import type { AnomalyDetectorService } from './anomaly-detector.service'
import type { RecurringDetectorService } from './recurring-detector.service'
import type { ForecastService } from './forecast.service'
import type { IAIProvider } from '../../../core/ai/ai-provider.interface'

export class MonthlyReportService {
  private readonly analysisRepo: IAnalysisRepository
  private readonly budgetRepo: IBudgetRepository
  private readonly userRepo: IUserRepository
  private readonly anomalyDetector: AnomalyDetectorService
  private readonly recurringDetector: RecurringDetectorService
  private readonly forecastService: ForecastService
  private readonly aiProvider: IAIProvider | undefined

  public constructor(deps: {
    readonly analysisRepo: IAnalysisRepository
    readonly budgetRepo: IBudgetRepository
    readonly userRepo: IUserRepository
    readonly anomalyDetector: AnomalyDetectorService
    readonly recurringDetector: RecurringDetectorService
    readonly forecastService: ForecastService
    readonly aiProvider?: IAIProvider | undefined
  }) {
    this.analysisRepo = deps.analysisRepo
    this.budgetRepo = deps.budgetRepo
    this.userRepo = deps.userRepo
    this.anomalyDetector = deps.anomalyDetector
    this.recurringDetector = deps.recurringDetector
    this.forecastService = deps.forecastService
    this.aiProvider = deps.aiProvider
  }

  public async generateReport(userId: string, monthStart: Date): Promise<any> {
    const start = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth(), 1, 0, 0, 0, 0))
    const end = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 0, 23, 59, 59, 999))
    const totalDays = end.getUTCDate()

    const now = new Date()
    let elapsedDays = totalDays
    if (now.getTime() < end.getTime()) {
      const diff = now.getTime() - start.getTime()
      elapsedDays = Math.max(1, Math.min(totalDays, Math.ceil(diff / (1000 * 60 * 60 * 24))))
    }

    // 1. Category totals and % of total spend
    const currentCategoryTotals = await this.analysisRepo.getCategoryTotals(userId, start, end)
    const currentTotalSpent = currentCategoryTotals.reduce((sum, c) => sum + c.totalSpentKobo, 0n)

    const categoryTotals = currentCategoryTotals.map((c) => {
      const percentage =
        currentTotalSpent > 0n
          ? (Number(c.totalSpentKobo * 10000n / currentTotalSpent) / 100).toFixed(2)
          : '0.00'
      return {
        categoryId: c.categoryId,
        categoryName: c.categoryName,
        spentKobo: c.totalSpentKobo.toString(),
        percentage,
      }
    })

    // 2. MoM changes
    const prevStart = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() - 1, 1, 0, 0, 0, 0))
    const prevEnd = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 0, 23, 59, 59, 999))

    const prevCategoryTotals = await this.analysisRepo.getCategoryTotals(userId, prevStart, prevEnd)
    const prevTotalSpent = prevCategoryTotals.reduce((sum, c) => sum + c.totalSpentKobo, 0n)

    let momPercentageChange = '0.00'
    if (prevTotalSpent === 0n) {
      momPercentageChange = currentTotalSpent > 0n ? '100.00' : '0.00'
    } else {
      momPercentageChange = (
        Number(currentTotalSpent - prevTotalSpent) /
        Number(prevTotalSpent) *
        100
      ).toFixed(2)
    }

    // 3. Income vs spend and savings rate
    const currentTransactions = await this.analysisRepo.getTransactionsForPeriod(userId, start, end)
    const totalSpent = currentTransactions.reduce((sum, t) => (t.type === 'DEBIT' ? sum + t.amountKobo : sum), 0n)
    const totalIncome = currentTransactions.reduce((sum, t) => (t.type === 'CREDIT' ? sum + t.amountKobo : sum), 0n)

    const savingsRate =
      totalIncome > 0n
        ? (Number((totalIncome - totalSpent) * 10000n / totalIncome) / 100).toFixed(2)
        : '0.00'

    // 4. Top 5 merchants
    const merchantMap = new Map<string, bigint>()
    for (const tx of currentTransactions) {
      if (tx.type === 'DEBIT') {
        const currentSum = merchantMap.get(tx.merchantName) ?? 0n
        merchantMap.set(tx.merchantName, currentSum + tx.amountKobo)
      }
    }
    const topMerchants = Array.from(merchantMap.entries())
      .map(([merchantName, spentKobo]) => ({
        merchantName,
        spentKobo: spentKobo.toString(),
      }))
      .sort((a, b) => Number(BigInt(b.spentKobo) - BigInt(a.spentKobo)))
      .slice(0, 5)

    // 5. Spend by day of week
    const dailySpend = await this.analysisRepo.getDailySpend(userId, start, end)
    const spendByDay = dailySpend.map((d) => ({
      date: d.date,
      spentKobo: d.totalSpentKobo.toString(),
    }))

    // 6. Anomaly detection
    const rollingAverages = new Map<string, bigint>()
    await Promise.all(
      dailySpend.map(async (d) => {
        const dateObj = new Date(d.date)
        const avg = await this.analysisRepo.getRolling30DayAverage(userId, dateObj)
        rollingAverages.set(d.date, avg)
      }),
    )
    const anomalies = this.anomalyDetector.detectAnomalies(dailySpend, rollingAverages)

    // 7. Budget progress
    const allBudgets = await this.budgetRepo.findByUser(userId)
    const monthlyBudgets = allBudgets.filter((b) => b.periodType === 'MONTHLY')
    const budgetProgress = await Promise.all(
      monthlyBudgets.map(async (b) => {
        const spentKobo = await this.budgetRepo.getSpentKobo(userId, b.categoryId, start, end)
        const limitKobo = BigInt(b.limitKobo)
        const remainingKobo = limitKobo - spentKobo
        const projectedSpentKobo = (spentKobo * BigInt(totalDays)) / BigInt(elapsedDays)

        let status: 'GREEN' | 'YELLOW' | 'RED' = 'GREEN'
        const spentRatio = limitKobo > 0n ? Number(spentKobo) / Number(limitKobo) : 0
        if (spentRatio >= 1.0) {
          status = 'RED'
        } else if (spentRatio >= 0.8) {
          status = 'YELLOW'
        }

        return {
          budgetId: b.id,
          categoryId: b.categoryId,
          limitKobo: limitKobo.toString(),
          spentKobo: spentKobo.toString(),
          remainingKobo: remainingKobo.toString(),
          projectedSpentKobo: projectedSpentKobo.toString(),
          status,
        }
      }),
    )

    // 8. Recurring transactions
    const historyStart = new Date(end)
    historyStart.setUTCDate(historyStart.getUTCDate() - 90)
    const historyTransactions = await this.analysisRepo.getTransactionsForPeriod(userId, historyStart, end)
    const recurring = this.recurringDetector.detectRecurring(historyTransactions)

    // 9. Cash flow forecast
    const forecast = this.forecastService.calculateForecast({
      spentKobo: totalSpent,
      incomeKobo: totalIncome,
      elapsedDays,
      totalDays,
    })

    // 10. AI narrative insights
    const user = await this.userRepo.findById(userId)
    const tier = user?.tier ?? 'FREE'
    let narrative = ''

    if (tier === 'PRO' && this.aiProvider) {
      const reportSummary = {
        schemaVersion: 1,
        periodStart: start.toISOString().split('T')[0]!,
        periodEnd: end.toISOString().split('T')[0]!,
        totalSpentKobo: totalSpent.toString(),
        totalIncomeKobo: totalIncome.toString(),
      }
      const rawNarrative = await this.aiProvider.generateInsightNarrative(reportSummary)
      // Censor forbidden keywords: invest, recommend, you should, etc.
      let censored = rawNarrative.replace(
        /\b(invest|recommend|you should|you must|should invest|investment|advisable)\b/gi,
        'observe',
      )
      // Ensure legal disclaimer is present
      const disclaimer = 'This is a spending summary, not financial advice.'
      if (!censored.includes(disclaimer)) {
        censored = `${censored}\n\n${disclaimer}`
      }
      narrative = censored
    } else {
      // Free tier basic narrative
      const totalSpentNaira = (Number(totalSpent) / 100).toFixed(2)
      const totalIncomeNaira = (Number(totalIncome) / 100).toFixed(2)
      narrative = `You spent ₦${totalSpentNaira} and earned ₦${totalIncomeNaira} this month. This is a spending summary, not financial advice.`
    }

    return {
      categoryTotals,
      momChange: {
        percentageChange: momPercentageChange,
        previousSpentKobo: prevTotalSpent.toString(),
      },
      incomeVsSpend: {
        totalSpentKobo: totalSpent.toString(),
        totalIncomeKobo: totalIncome.toString(),
        savingsRate,
      },
      topMerchants,
      spendByDay,
      anomalies,
      budgets: budgetProgress,
      recurring,
      forecast,
      narrative,
    }
  }
}
