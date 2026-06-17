export type ForecastResult = {
  readonly projectedSpentKobo: string
  readonly projectedIncomeKobo: string
  readonly projectedNetKobo: string
  readonly confidenceRating: 'HIGH' | 'MEDIUM' | 'LOW'
}

export class ForecastService {
  public calculateForecast(options: {
    readonly spentKobo: bigint
    readonly incomeKobo: bigint
    readonly elapsedDays: number
    readonly totalDays: number
  }): ForecastResult {
    const { spentKobo, incomeKobo, elapsedDays, totalDays } = options

    if (elapsedDays <= 0) {
      return {
        projectedSpentKobo: spentKobo.toString(),
        projectedIncomeKobo: incomeKobo.toString(),
        projectedNetKobo: (incomeKobo - spentKobo).toString(),
        confidenceRating: 'LOW',
      }
    }

    const elapsedDaysBi = BigInt(elapsedDays)
    const totalDaysBi = BigInt(totalDays)

    const projectedSpent = (spentKobo * totalDaysBi) / elapsedDaysBi
    const projectedIncome = (incomeKobo * totalDaysBi) / elapsedDaysBi
    const projectedNet = projectedIncome - projectedSpent

    const ratio = elapsedDays / totalDays
    let confidenceRating: 'HIGH' | 'MEDIUM' | 'LOW' = 'LOW'
    if (ratio >= 0.7) {
      confidenceRating = 'HIGH'
    } else if (ratio >= 0.3) {
      confidenceRating = 'MEDIUM'
    }

    return {
      projectedSpentKobo: projectedSpent.toString(),
      projectedIncomeKobo: projectedIncome.toString(),
      projectedNetKobo: projectedNet.toString(),
      confidenceRating,
    }
  }
}
