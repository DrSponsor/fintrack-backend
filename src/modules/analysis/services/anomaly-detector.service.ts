import type { DailySpend } from '../repositories/analysis.repo'

export type AnomalyRecord = {
  readonly date: string
  readonly spentKobo: string
  readonly thresholdKobo: string
}

export class AnomalyDetectorService {
  public detectAnomalies(
    dailySpend: readonly DailySpend[],
    rollingAverages: ReadonlyMap<string, bigint>,
  ): readonly AnomalyRecord[] {
    const anomalies: AnomalyRecord[] = []

    for (const spend of dailySpend) {
      const avg = rollingAverages.get(spend.date) ?? 0n
      const limit = avg * 2n

      // Flag daily spends exceeding 2x rolling average, with a minimum 10,000 kobo (₦100) threshold to prevent noise
      if (spend.totalSpentKobo > limit && spend.totalSpentKobo > 10000n) {
        anomalies.push({
          date: spend.date,
          spentKobo: spend.totalSpentKobo.toString(),
          thresholdKobo: limit.toString(),
        })
      }
    }
    return anomalies
  }
}
