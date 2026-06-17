import type { PrismaClient } from '../../../generated/prisma/client'
import { randomUUID } from 'node:crypto'
import type { PeriodType } from '../../../generated/prisma/enums'

export type BudgetRecord = {
  readonly id: string
  readonly userId: string
  readonly categoryId: string
  readonly limitKobo: string
  readonly periodType: 'WEEKLY' | 'MONTHLY'
  readonly createdAt: Date
}

export interface IBudgetRepository {
  create(data: {
    readonly userId: string
    readonly categoryId: string
    readonly limitKobo: bigint
    readonly periodType: 'WEEKLY' | 'MONTHLY'
  }): Promise<BudgetRecord>
  findById(id: string): Promise<BudgetRecord | null>
  findByUser(userId: string): Promise<readonly BudgetRecord[]>
  findByCategoryAndPeriod(
    userId: string,
    categoryId: string,
    periodType: 'WEEKLY' | 'MONTHLY',
  ): Promise<readonly BudgetRecord[]>
  findByCategory(userId: string, categoryId: string): Promise<readonly BudgetRecord[]>
  delete(id: string): Promise<void>
  createAlert(transactionId: string, budgetId: string, userId: string): Promise<void>
  getAlertCount(transactionId: string, budgetId: string): Promise<number>
  getSpentKobo(
    userId: string,
    categoryId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<bigint>
}

export class PrismaBudgetRepository implements IBudgetRepository {
  public constructor(private readonly prisma: PrismaClient) {}

  public async create(data: {
    readonly userId: string
    readonly categoryId: string
    readonly limitKobo: bigint
    readonly periodType: 'WEEKLY' | 'MONTHLY'
  }): Promise<BudgetRecord> {
    const row = await this.prisma.budget.create({
      data: {
        id: randomUUID(),
        userId: data.userId,
        categoryId: data.categoryId,
        limitKobo: data.limitKobo,
        periodType: data.periodType as PeriodType,
      },
    })
    return this.toDomain(row)
  }

  public async findById(id: string): Promise<BudgetRecord | null> {
    const row = await this.prisma.budget.findUnique({
      where: { id },
    })
    return row ? this.toDomain(row) : null
  }

  public async findByUser(userId: string): Promise<readonly BudgetRecord[]> {
    const rows = await this.prisma.budget.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    })
    return rows.map((r) => this.toDomain(r))
  }

  public async findByCategoryAndPeriod(
    userId: string,
    categoryId: string,
    periodType: 'WEEKLY' | 'MONTHLY',
  ): Promise<readonly BudgetRecord[]> {
    const rows = await this.prisma.budget.findMany({
      where: {
        userId,
        categoryId,
        periodType: periodType as PeriodType,
      },
    })
    return rows.map((r) => this.toDomain(r))
  }

  public async findByCategory(userId: string, categoryId: string): Promise<readonly BudgetRecord[]> {
    const rows = await this.prisma.budget.findMany({
      where: {
        userId,
        categoryId,
      },
    })
    return rows.map((r) => this.toDomain(r))
  }

  public async delete(id: string): Promise<void> {
    await this.prisma.budget.delete({
      where: { id },
    })
  }

  public async createAlert(transactionId: string, budgetId: string, userId: string): Promise<void> {
    // TOCTOU-safe insert-then-catch is enforced at DB unique constraint level.
    // If double write occurs, unique constraint [transactionId, budgetId] throws.
    try {
      await this.prisma.budgetAlert.create({
        data: {
          id: randomUUID(),
          transactionId,
          budgetId,
          userId,
        },
      })
    } catch (error: any) {
      // Check for PostgreSQL unique constraint error code (P2002 in Prisma)
      if (error.code === 'P2002') {
        return
      }
      throw error
    }
  }

  public async getAlertCount(transactionId: string, budgetId: string): Promise<number> {
    return this.prisma.budgetAlert.count({
      where: {
        transactionId,
        budgetId,
      },
    })
  }

  public async getSpentKobo(
    userId: string,
    categoryId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<bigint> {
    const aggregate = await this.prisma.transaction.aggregate({
      where: {
        account: { userId },
        categoryId,
        type: 'DEBIT',
        transactionDate: {
          gte: startDate,
          lte: endDate,
        },
      },
      _sum: {
        amountKobo: true,
      },
    })
    return aggregate._sum.amountKobo ?? 0n
  }

  private toDomain(row: {
    id: string
    userId: string
    categoryId: string
    limitKobo: bigint
    periodType: PeriodType
    createdAt: Date
  }): BudgetRecord {
    return {
      id: row.id,
      userId: row.userId,
      categoryId: row.categoryId,
      limitKobo: row.limitKobo.toString(),
      periodType: row.periodType as 'WEEKLY' | 'MONTHLY',
      createdAt: row.createdAt,
    }
  }
}
