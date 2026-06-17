import { randomUUID } from 'node:crypto'
import type { PrismaClient } from '../../../generated/prisma/client'

export type ReportRecord = {
  readonly id: string
  readonly userId: string
  readonly periodType: 'WEEKLY' | 'MONTHLY'
  readonly periodStart: Date
  readonly periodEnd: Date
  readonly isStale: boolean
  readonly schemaVersion: number
  readonly data: any
  readonly generatedAt: Date
}

export type TransactionSummary = {
  readonly id: string
  readonly amountKobo: bigint
  readonly type: 'DEBIT' | 'CREDIT'
  readonly merchantName: string
  readonly categoryId: string
  readonly transactionDate: Date
}

export type CategoryTotal = {
  readonly categoryId: string
  readonly categoryName: string
  readonly totalSpentKobo: bigint
}

export type DailySpend = {
  readonly date: string // YYYY-MM-DD
  readonly totalSpentKobo: bigint
}

export interface IAnalysisRepository {
  getReport(
    userId: string,
    periodType: 'WEEKLY' | 'MONTHLY',
    periodStart: Date,
  ): Promise<ReportRecord | null>

  upsertReport(
    userId: string,
    periodType: 'WEEKLY' | 'MONTHLY',
    periodStart: Date,
    periodEnd: Date,
    data: any,
  ): Promise<void>

  markStale(userId: string, periodType: 'WEEKLY' | 'MONTHLY', periodStart: Date): Promise<void>

  getTransactionsForPeriod(userId: string, start: Date, end: Date): Promise<readonly TransactionSummary[]>

  getCategoryTotals(userId: string, start: Date, end: Date): Promise<readonly CategoryTotal[]>

  getDailySpend(userId: string, start: Date, end: Date): Promise<readonly DailySpend[]>

  getRolling30DayAverage(userId: string, date: Date): Promise<bigint>
}

export class PrismaAnalysisRepository implements IAnalysisRepository {
  public constructor(
    private readonly prismaPrimary: PrismaClient,
    private readonly prismaRead: PrismaClient,
  ) {}

  public async getReport(
    userId: string,
    periodType: 'WEEKLY' | 'MONTHLY',
    periodStart: Date,
  ): Promise<ReportRecord | null> {
    const row = await this.prismaRead.report.findUnique({
      where: {
        userId_periodType_periodStart: {
          userId,
          periodType,
          periodStart,
        },
      },
    })
    return row ? this.toDomain(row) : null
  }

  public async upsertReport(
    userId: string,
    periodType: 'WEEKLY' | 'MONTHLY',
    periodStart: Date,
    periodEnd: Date,
    data: any,
  ): Promise<void> {
    const id = randomUUID()
    await this.prismaPrimary.report.upsert({
      where: {
        userId_periodType_periodStart: {
          userId,
          periodType,
          periodStart,
        },
      },
      update: {
        periodEnd,
        data,
        isStale: false,
        generatedAt: new Date(),
      },
      create: {
        id,
        userId,
        periodType,
        periodStart,
        periodEnd,
        data,
        isStale: false,
        generatedAt: new Date(),
      },
    })
  }

  public async markStale(
    userId: string,
    periodType: 'WEEKLY' | 'MONTHLY',
    periodStart: Date,
  ): Promise<void> {
    await this.prismaPrimary.report.updateMany({
      where: {
        userId,
        periodType,
        periodStart,
      },
      data: {
        isStale: true,
      },
    })
  }

  public async getTransactionsForPeriod(
    userId: string,
    start: Date,
    end: Date,
  ): Promise<readonly TransactionSummary[]> {
    const rows = await this.prismaRead.transaction.findMany({
      where: {
        account: { userId },
        transactionDate: {
          gte: start,
          lte: end,
        },
      },
      select: {
        id: true,
        amountKobo: true,
        type: true,
        merchantName: true,
        categoryId: true,
        transactionDate: true,
      },
      orderBy: { transactionDate: 'desc' },
    })
    return rows.map((r) => ({
      id: r.id,
      amountKobo: r.amountKobo,
      type: r.type as 'DEBIT' | 'CREDIT',
      merchantName: r.merchantName,
      categoryId: r.categoryId,
      transactionDate: r.transactionDate,
    }))
  }

  public async getCategoryTotals(
    userId: string,
    start: Date,
    end: Date,
  ): Promise<readonly CategoryTotal[]> {
    const rows = await this.prismaRead.$queryRawUnsafe<Array<{
      readonly categoryId: string
      readonly categoryName: string
      readonly totalSpentKobo: string | bigint
    }>>(
      `SELECT t.category_id AS "categoryId", c.name AS "categoryName", SUM(t.amount_kobo) AS "totalSpentKobo"
       FROM transactions t
       JOIN categories c ON t.category_id = c.id
       JOIN accounts a ON t.account_id = a.id
       WHERE a.user_id = $1::uuid
         AND t.type = 'DEBIT'
         AND t.transaction_date >= $2::timestamp
         AND t.transaction_date <= $3::timestamp
       GROUP BY t.category_id, c.name
       ORDER BY "totalSpentKobo" DESC`,
      userId,
      start,
      end,
    )
    return rows.map((r) => ({
      categoryId: r.categoryId,
      categoryName: r.categoryName,
      totalSpentKobo: BigInt(r.totalSpentKobo),
    }))
  }

  public async getDailySpend(
    userId: string,
    start: Date,
    end: Date,
  ): Promise<readonly DailySpend[]> {
    const rows = await this.prismaRead.$queryRawUnsafe<Array<{
      readonly date: string
      readonly totalSpentKobo: string | bigint
    }>>(
      `SELECT TO_CHAR(t.transaction_date, 'YYYY-MM-DD') AS "date", SUM(t.amount_kobo) AS "totalSpentKobo"
       FROM transactions t
       JOIN accounts a ON t.account_id = a.id
       WHERE a.user_id = $1::uuid
         AND t.type = 'DEBIT'
         AND t.transaction_date >= $2::timestamp
         AND t.transaction_date <= $3::timestamp
       GROUP BY TO_CHAR(t.transaction_date, 'YYYY-MM-DD')
       ORDER BY "date" ASC`,
      userId,
      start,
      end,
    )
    return rows.map((r) => ({
      date: r.date,
      totalSpentKobo: BigInt(r.totalSpentKobo),
    }))
  }

  public async getRolling30DayAverage(userId: string, date: Date): Promise<bigint> {
    const start = new Date(date)
    start.setUTCDate(start.getUTCDate() - 30)

    const rows = await this.prismaRead.$queryRawUnsafe<Array<{
      readonly avgSpentKobo: string | bigint | null
    }>>(
      `SELECT COALESCE(SUM(t.amount_kobo) / 30, 0) AS "avgSpentKobo"
       FROM transactions t
       JOIN accounts a ON t.account_id = a.id
       WHERE a.user_id = $1::uuid
         AND t.type = 'DEBIT'
         AND t.transaction_date >= $2::timestamp
         AND t.transaction_date < $3::timestamp`,
      userId,
      start,
      date,
    )
    return BigInt(rows[0]?.avgSpentKobo ?? 0n)
  }

  private toDomain(row: {
    readonly id: string
    readonly userId: string
    readonly periodType: 'WEEKLY' | 'MONTHLY'
    readonly periodStart: Date
    readonly periodEnd: Date
    readonly isStale: boolean
    readonly schemaVersion: number
    readonly data: any
    readonly generatedAt: Date
  }): ReportRecord {
    return {
      id: row.id,
      userId: row.userId,
      periodType: row.periodType,
      periodStart: row.periodStart,
      periodEnd: row.periodEnd,
      isStale: row.isStale,
      schemaVersion: row.schemaVersion,
      data: row.data,
      generatedAt: row.generatedAt,
    }
  }
}
