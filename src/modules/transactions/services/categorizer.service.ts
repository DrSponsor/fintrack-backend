import type { Redis } from 'ioredis'
import type { IAIProvider } from '../../../core/ai/ai-provider.interface'
import type { AppLogger } from '../../../core/logger'

export interface ICategorizationRepository {
  findMerchantMapping(fingerprint: string): Promise<string | null>
  findKeywordMappings(): Promise<readonly { readonly keyword: string; readonly categoryId: string }[]>
  findUserPreference(userId: string, fingerprint: string): Promise<string | null>
  saveMerchantMapping(fingerprint: string, categoryId: string, confidence: number): Promise<void>
  findUncategorisedId(): Promise<string | null>
}

export type CategorizerServiceDeps = {
  readonly mappingRepo: ICategorizationRepository
  readonly aiProvider: IAIProvider
  readonly redis: Redis
  readonly logger: AppLogger
}

export class CategorizerService {
  private readonly mappingRepo: ICategorizationRepository
  private readonly aiProvider: IAIProvider
  private readonly redis: Redis
  private readonly logger: AppLogger
  private uncategorisedId: string | null = null
  private cachedKeywords: readonly { readonly keyword: string; readonly categoryId: string }[] | null = null
  private lastCacheTime = 0

  public constructor(deps: CategorizerServiceDeps) {
    this.mappingRepo = deps.mappingRepo
    this.aiProvider = deps.aiProvider
    this.redis = deps.redis
    this.logger = deps.logger
  }

  private async getUncategorisedId(): Promise<string> {
    if (this.uncategorisedId === null) {
      const id = await this.mappingRepo.findUncategorisedId()
      this.uncategorisedId = id ?? 'uncategorised'
    }
    return this.uncategorisedId
  }

  public async categorize(
    userId: string,
    tier: 'FREE' | 'PRO',
    merchantName: string,
    amountKobo: bigint,
    fingerprint: string,
  ): Promise<string> {
    const uncategorisedId = await this.getUncategorisedId()

    // Tier 1: Exact merchant mapping
    const exactMatch = await this.mappingRepo.findMerchantMapping(fingerprint)
    if (exactMatch !== null) {
      return exactMatch
    }

    // Tier 2: User preferences
    const userPref = await this.mappingRepo.findUserPreference(userId, fingerprint)
    if (userPref !== null) {
      return userPref
    }

    // Tier 3: Keyword mapping
    const keywords = await this.getKeywordMappings()
    for (const kw of keywords) {
      if (merchantName.toLowerCase().includes(kw.keyword.toLowerCase())) {
        return kw.categoryId
      }
    }

    // Tier 4: AI categorization
    const monthlyLimit = tier === 'FREE' ? 50 : 200
    const now = new Date()
    const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
    const aiKey = `ai:calls:${userId}:${yearMonth}`

    try {
      const callsCountStr = await this.redis.get(aiKey)
      const callsCount = callsCountStr ? parseInt(callsCountStr, 10) : 0

      if (callsCount < monthlyLimit) {
        // Increment count first (optimistic lock / ceiling check)
        await this.redis.incr(aiKey)
        // Set expiry if it's the first call this month (35 days TTL is safe)
        if (callsCount === 0) {
          await this.redis.expire(aiKey, 35 * 24 * 60 * 60)
        }

        const aiResult = await this.aiProvider.categorize(merchantName, amountKobo)
        if (aiResult.categoryId !== uncategorisedId && aiResult.confidence > 0.6) {
          // Save result for future exact matches
          await this.mappingRepo.saveMerchantMapping(
            fingerprint,
            aiResult.categoryId,
            Math.round(aiResult.confidence * 100),
          )
          return aiResult.categoryId
        }
      } else {
        this.logger.warn({ userId, limit: monthlyLimit }, 'AI monthly limit reached, fallback to uncategorised')
      }
    } catch (error) {
      this.logger.error({ err: error, userId }, 'AI categorization failed')
    }

    // Tier 5: Fallback to uncategorised
    return uncategorisedId
  }

  private async getKeywordMappings(): Promise<readonly { readonly keyword: string; readonly categoryId: string }[]> {
    const now = Date.now()
    // Cache keyword mappings in-memory for 5 minutes
    if (this.cachedKeywords === null || now - this.lastCacheTime > 5 * 60 * 1000) {
      this.cachedKeywords = await this.mappingRepo.findKeywordMappings()
      this.lastCacheTime = now
    }
    return this.cachedKeywords
  }
}
