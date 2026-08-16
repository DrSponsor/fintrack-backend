import type { TransactionSummary } from '../repositories/analysis.repo'

export type RecurringTransaction = {
  readonly merchantName: string
  readonly amountKobo: string
  readonly frequency: 'WEEKLY' | 'MONTHLY'
  readonly nextExpectedDate: string // YYYY-MM-DD
}

export class RecurringDetectorService {
  public detectRecurring(transactions: readonly TransactionSummary[]): readonly RecurringTransaction[] {
    // 1. Group transactions by merchant name and amount
    const groups = new Map<string, TransactionSummary[]>()
    for (const tx of transactions) {
      if (tx.type !== 'DEBIT') continue
      const key = `${tx.merchantName.toLowerCase().trim()}:${tx.amountKobo.toString()}`
      const list = groups.get(key) ?? []
      list.push(tx)
      groups.set(key, list)
    }

    const recurring: RecurringTransaction[] = []

    for (const [_, list] of groups.entries()) {
      if (list.length < 3) continue

      // Sort by date ascending
      const sorted = [...list].sort((a, b) => a.transactionDate.getTime() - b.transactionDate.getTime())

      // Calculate diffs in days
      const intervals: number[] = []
      for (let i = 0; i < sorted.length - 1; i++) {
        const txA = sorted[i]
        const txB = sorted[i + 1]
        if (txA === undefined || txB === undefined) continue
        const diffDays = Math.round((txB.transactionDate.getTime() - txA.transactionDate.getTime()) / (1000 * 60 * 60 * 24))
        intervals.push(diffDays)
      }

      // Check if intervals are consistently weekly (6-8 days)
      const isWeekly = intervals.every((days) => days >= 6 && days <= 8)
      // Check if intervals are consistently monthly (27-33 days)
      const isMonthly = intervals.every((days) => days >= 27 && days <= 33)

      const lastTx = sorted[sorted.length - 1]
      if ((isWeekly || isMonthly) && lastTx !== undefined) {
        const intervalDays = isWeekly ? 7 : 30
        const nextDateObj = new Date(lastTx.transactionDate)
        nextDateObj.setUTCDate(nextDateObj.getUTCDate() + intervalDays)

        recurring.push({
          merchantName: lastTx.merchantName,
          amountKobo: lastTx.amountKobo.toString(),
          frequency: isWeekly ? 'WEEKLY' : 'MONTHLY',
          nextExpectedDate: nextDateObj.toISOString().slice(0, 10),
        })
      }
    }

    return recurring
  }
}
