import { createHash } from 'node:crypto'
import type { PrismaClient } from '../../../generated/prisma/client'
import type { AppLogger } from '../../../core/logger'

// ──────────────────────────────────────────────────────────────────
// Domain types
// ──────────────────────────────────────────────────────────────────

export type UserExportData = {
  readonly user: {
    readonly email: string
    readonly tier: string
    readonly createdAt: Date
  }
  readonly accounts: ReadonlyArray<{
    readonly bankName: string
    readonly accountLast4: string
    readonly accountType: string
    readonly captureMethod: string
    readonly balanceKobo: string
  }>
  readonly transactions: ReadonlyArray<{
    readonly amountKobo: string
    readonly type: string
    readonly merchantName: string
    readonly transactionDate: Date
    readonly source: string
  }>
  readonly budgets: ReadonlyArray<{
    readonly limitKobo: string
    readonly periodType: string
    readonly categoryName: string
  }>
  readonly reports: ReadonlyArray<{
    readonly periodType: string
    readonly periodStart: Date
    readonly periodEnd: Date
    readonly generatedAt: Date
  }>
}

// ──────────────────────────────────────────────────────────────────
// Repository interface
// ──────────────────────────────────────────────────────────────────

export interface IPrivacyRepository {
  scheduleDeletion(userId: string, scheduledAt: Date): Promise<void>
  cancelDeletion(userId: string): Promise<void>
  getDeletionScheduledAt(userId: string): Promise<Date | null>
  getUserExportData(userId: string): Promise<UserExportData | null>
  executeAccountDeletion(userId: string, userEmail: string, logger: AppLogger): Promise<void>
}

// ──────────────────────────────────────────────────────────────────
// Prisma implementation
// ──────────────────────────────────────────────────────────────────

export class PrismaPrivacyRepository implements IPrivacyRepository {
  private readonly prisma: PrismaClient

  public constructor(prisma: PrismaClient) {
    this.prisma = prisma
  }

  public async scheduleDeletion(userId: string, scheduledAt: Date): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { deletionScheduledAt: scheduledAt },
    })
  }

  public async cancelDeletion(userId: string): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { deletionScheduledAt: null },
    })
  }

  public async getDeletionScheduledAt(userId: string): Promise<Date | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { deletionScheduledAt: true },
    })
    return user?.deletionScheduledAt ?? null
  }

  public async getUserExportData(userId: string): Promise<UserExportData | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, tier: true, createdAt: true },
    })

    if (!user) {
      return null
    }

    const accounts = await this.prisma.account.findMany({
      where: { userId },
      select: {
        bankName: true,
        accountLast4: true,
        accountType: true,
        captureMethod: true,
        balanceKobo: true,
      },
    })

    const transactions = await this.prisma.transaction.findMany({
      where: { account: { userId } },
      select: {
        amountKobo: true,
        type: true,
        merchantName: true,
        transactionDate: true,
        source: true,
      },
      orderBy: { transactionDate: 'desc' },
    })

    const budgets = await this.prisma.budget.findMany({
      where: { userId },
      select: {
        limitKobo: true,
        periodType: true,
        category: { select: { name: true } },
      },
    })

    const reports = await this.prisma.report.findMany({
      where: { userId },
      select: {
        periodType: true,
        periodStart: true,
        periodEnd: true,
        generatedAt: true,
      },
      orderBy: { periodStart: 'desc' },
    })

    return {
      user: {
        email: user.email,
        tier: user.tier,
        createdAt: user.createdAt,
      },
      accounts: accounts.map((a) => ({
        bankName: a.bankName,
        accountLast4: a.accountLast4,
        accountType: a.accountType,
        captureMethod: a.captureMethod,
        balanceKobo: a.balanceKobo.toString(),
      })),
      transactions: transactions.map((t) => ({
        amountKobo: t.amountKobo.toString(),
        type: t.type,
        merchantName: t.merchantName,
        transactionDate: t.transactionDate,
        source: t.source,
      })),
      budgets: budgets.map((b) => ({
        limitKobo: b.limitKobo.toString(),
        periodType: b.periodType,
        categoryName: b.category.name,
      })),
      reports: reports.map((r) => ({
        periodType: r.periodType,
        periodStart: r.periodStart,
        periodEnd: r.periodEnd,
        generatedAt: r.generatedAt,
      })),
    }
  }

  /**
   * Cascade account deletion — follows the exact sequence documented in
   * FinTrack_Backend_Architecture.md lines 1574-1610.
   *
   * CRITICAL: The order of operations is deterministic and must not change.
   * Each step is logged for auditability during the deletion process.
   *
   * Steps 1 (OAuth revocation) is handled by the caller/worker before
   * invoking this method.
   */
  public async executeAccountDeletion(userId: string, userEmail: string, logger: AppLogger): Promise<void> {
    const anonymizedId = createHash('sha256').update(userId).digest('hex')

    logger.info({ userId }, 'Starting cascaded account deletion')

    await this.prisma.$transaction([
      // Step 2: Delete BudgetAlert records for user's transactions
      this.prisma.budgetAlert.deleteMany({
        where: { userId },
      }),

      // Steps 3 & 4: Delete Transactions (TransactionEvent cascades automatically via onDelete: Cascade)
      this.prisma.transaction.deleteMany({
        where: { account: { userId } },
      }),

      // Step 5: Delete Report records
      this.prisma.report.deleteMany({
        where: { userId },
      }),

      // Step 6: Delete Budget records
      this.prisma.budget.deleteMany({
        where: { userId },
      }),

      // Step 7: Delete Account records (encrypted Gmail tokens already revoked in step 1)
      this.prisma.account.deleteMany({
        where: { userId },
      }),

      // Step 7b: Delete UserMerchantPreference records
      this.prisma.userMerchantPreference.deleteMany({
        where: { userId },
      }),

      // Step 7c: Delete DeviceToken records
      this.prisma.deviceToken.deleteMany({
        where: { userId },
      }),

      // Step 7d: Delete NotificationPreference record
      this.prisma.notificationPreference.deleteMany({
        where: { userId },
      }),

      // Step 8: Hard-delete Subscription record
      this.prisma.subscription.deleteMany({
        where: { userId },
      }),

      // Step 9: Anonymise BillingEvent records — replace userId with SHA256(userId)
      this.prisma.billingEvent.updateMany({
        where: { userId },
        data: {
          userId: null,
          anonymizedUserId: anonymizedId,
        },
      }),

      // Step 10: Anonymise AuditLog records — replace userId with SHA256(userId)
      this.prisma.auditLog.updateMany({
        where: { userId },
        data: { userId: anonymizedId },
      }),

      // Step 11: Delete User record — last step, foreign key anchor
      this.prisma.user.delete({
        where: { id: userId },
      }),
    ])

    logger.info({ userId, email: userEmail }, 'Cascaded account deletion completed successfully')
  }
}
