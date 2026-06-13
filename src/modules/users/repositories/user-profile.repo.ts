import type { PrismaClient } from '../../../generated/prisma/client'
import type { Tier } from '../../../types/auth'

// ──────────────────────────────────────────────────────────────────
// Domain types
// ──────────────────────────────────────────────────────────────────

export type UserProfile = {
  readonly id: string
  readonly email: string
  readonly phone: string | null
  readonly tier: Tier
  readonly accountCount: number
  readonly createdAt: Date
}

export type UpdateProfileData = {
  readonly phone?: string | undefined
}

// ──────────────────────────────────────────────────────────────────
// Repository interface
// ──────────────────────────────────────────────────────────────────

export interface IUserProfileRepository {
  findById(id: string): Promise<UserProfile | null>
  update(id: string, data: UpdateProfileData): Promise<UserProfile>
  deleteAllData(userId: string): Promise<void>
}

// ──────────────────────────────────────────────────────────────────
// Prisma implementation
// ──────────────────────────────────────────────────────────────────

export class PrismaUserProfileRepository implements IUserProfileRepository {
  private readonly prisma: PrismaClient

  public constructor(prisma: PrismaClient) {
    this.prisma = prisma
  }

  public async findById(id: string): Promise<UserProfile | null> {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        phone: true,
        tier: true,
        createdAt: true,
        _count: { select: { accounts: true } },
      },
    })

    if (user === null) {
      return null
    }

    return {
      id: user.id,
      email: user.email,
      phone: user.phone,
      tier: user.tier as Tier,
      accountCount: user._count.accounts,
      createdAt: user.createdAt,
    }
  }

  public async update(id: string, data: UpdateProfileData): Promise<UserProfile> {
    const user = await this.prisma.user.update({
      where: { id },
      data: {
        ...(data.phone !== undefined ? { phone: data.phone } : {}),
      },
      select: {
        id: true,
        email: true,
        phone: true,
        tier: true,
        createdAt: true,
        _count: { select: { accounts: true } },
      },
    })

    return {
      id: user.id,
      email: user.email,
      phone: user.phone,
      tier: user.tier as Tier,
      accountCount: user._count.accounts,
      createdAt: user.createdAt,
    }
  }

  /**
   * NDPR-compliant data deletion.
   *
   * Architecture spec: 11-step deletion sequence.
   * Prisma cascade handles most relations (Account, Budget, Report, etc.)
   * since they have `onDelete: Cascade` in the schema.
   *
   * This is an array-based transaction (no interactive transactions —
   * PgBouncer constraint). The order matters: dependent tables first.
   */
  public async deleteAllData(userId: string): Promise<void> {
    await this.prisma.$transaction([
      // 1. Delete budget alerts (depends on budgets and transactions)
      this.prisma.budgetAlert.deleteMany({ where: { userId } }),
      // 2. Delete merchant preferences
      this.prisma.userMerchantPreference.deleteMany({ where: { userId } }),
      // 3. Delete budgets
      this.prisma.budget.deleteMany({ where: { userId } }),
      // 4. Delete reports
      this.prisma.report.deleteMany({ where: { userId } }),
      // 5. Delete subscription
      this.prisma.subscription.deleteMany({ where: { userId } }),
      // 6. Delete accounts (cascade deletes transactions, transaction events)
      this.prisma.account.deleteMany({ where: { userId } }),
      // 7. Delete audit logs
      this.prisma.auditLog.deleteMany({ where: { userId } }),
      // 8. Delete the user
      this.prisma.user.delete({ where: { id: userId } }),
    ])
  }
}
