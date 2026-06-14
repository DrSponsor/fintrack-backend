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
