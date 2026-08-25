import type { PrismaClient } from '../../../generated/prisma/client'
import type { ICategorizationRepository } from '../services/categorizer.service'

export class PrismaCategorizationRepository implements ICategorizationRepository {
  private readonly prisma: PrismaClient

  public constructor(prisma: PrismaClient) {
    this.prisma = prisma
  }

  public async findUncategorisedId(): Promise<string | null> {
    const category = await this.prisma.category.findUnique({
      where: { name: 'uncategorised' },
      select: { id: true },
    })
    return category?.id ?? null
  }

  /**
   * Distinct users per category for one merchant.
   *
   * A plain groupBy count is a distinct-user count here because
   * user_merchant_preferences is unique on (userId, merchantFingerprint) —
   * one row per person per merchant. See MerchantConsensusService for why
   * correctionCount must NOT be used instead.
   */
  public async tallyPreferences(
    fingerprint: string,
  ): Promise<readonly { readonly categoryId: string; readonly users: number }[]> {
    const rows = await this.prisma.userMerchantPreference.groupBy({
      by: ['categoryId'],
      where: { merchantFingerprint: fingerprint },
      _count: { userId: true },
    })
    return rows.map((row) => ({ categoryId: row.categoryId, users: row._count.userId }))
  }

  public async findMapping(
    fingerprint: string,
  ): Promise<{ readonly categoryId: string; readonly source: 'SEEDED' | 'USER_CORRECTION' | 'AI_CONFIRMED' } | null> {
    const mapping = await this.prisma.merchantCategoryMap.findUnique({
      where: { merchantFingerprint: fingerprint },
      select: { categoryId: true, source: true },
    })
    return mapping === null ? null : { categoryId: mapping.categoryId, source: mapping.source }
  }

  /**
   * Writes a crowd-established mapping.
   *
   * Confidence is 100 because this is not a model's estimate — it is a count of
   * real people who independently said the same thing, which is the strongest
   * evidence this system has.
   */
  public async promoteMapping(
    fingerprint: string,
    categoryId: string,
    confirmedByUsers: number,
  ): Promise<void> {
    await this.prisma.merchantCategoryMap.upsert({
      where: { merchantFingerprint: fingerprint },
      create: {
        merchantFingerprint: fingerprint,
        categoryId,
        source: 'USER_CORRECTION',
        confidence: 100,
        confirmedByUsers,
      },
      update: {
        categoryId,
        source: 'USER_CORRECTION',
        confidence: 100,
        confirmedByUsers,
      },
    })
  }

  public async findCategoryIdByName(name: string): Promise<string | null> {
    const category = await this.prisma.category.findUnique({
      where: { name },
      select: { id: true },
    })
    return category?.id ?? null
  }

  public async findMerchantMapping(fingerprint: string): Promise<string | null> {
    const mapping = await this.prisma.merchantCategoryMap.findUnique({
      where: { merchantFingerprint: fingerprint },
      select: { categoryId: true },
    })
    return mapping?.categoryId ?? null
  }

  public async findKeywordMappings(): Promise<readonly { readonly keyword: string; readonly categoryId: string }[]> {
    const keywords = await this.prisma.categoryKeyword.findMany({
      select: { keyword: true, categoryId: true },
    })
    return keywords
  }

  public async findUserPreference(userId: string, fingerprint: string): Promise<string | null> {
    const preference = await this.prisma.userMerchantPreference.findUnique({
      where: {
        userId_merchantFingerprint: {
          userId,
          merchantFingerprint: fingerprint,
        },
      },
      select: { categoryId: true },
    })
    return preference?.categoryId ?? null
  }

  public async saveMerchantMapping(fingerprint: string, categoryId: string, confidence: number): Promise<void> {
    await this.prisma.merchantCategoryMap.upsert({
      where: { merchantFingerprint: fingerprint },
      create: {
        merchantFingerprint: fingerprint,
        categoryId,
        source: 'AI_CONFIRMED',
        confidence,
      },
      update: {
        categoryId,
        source: 'AI_CONFIRMED',
        confidence,
      },
    })
  }
}
