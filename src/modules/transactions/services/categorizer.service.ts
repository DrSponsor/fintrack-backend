import type { Redis } from 'ioredis'
import type { IAIProvider } from '../../../core/ai/ai-provider.interface'
import type { AppLogger } from '../../../core/logger'

export interface ICategorizationRepository {
  findMerchantMapping(fingerprint: string): Promise<string | null>
  findKeywordMappings(): Promise<readonly { readonly keyword: string; readonly categoryId: string }[]>
  findUserPreference(userId: string, fingerprint: string): Promise<string | null>
  saveMerchantMapping(fingerprint: string, categoryId: string, confidence: number): Promise<void>
  findUncategorisedId(): Promise<string | null>
  findCategoryIdByName(name: string): Promise<string | null>
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
  /** Cached like uncategorisedId — a seeded row whose id never changes. */
  private transfersId: string | null = null
  private cachedKeywords: readonly { readonly keyword: string; readonly categoryId: string }[] | null = null
  private lastCacheTime = 0

  public constructor(deps: CategorizerServiceDeps) {
    this.mappingRepo = deps.mappingRepo
    this.aiProvider = deps.aiProvider
    this.redis = deps.redis
    this.logger = deps.logger
  }

  /**
   * The id of the `uncategorised` category — every tier below falls back to it.
   *
   * This used to substitute the literal string 'uncategorised' when the lookup
   * found nothing. `Transaction.categoryId` is a non-nullable `@db.Uuid`, so
   * that sentinel could never be written: Postgres rejected it with
   * `invalid input syntax for type uuid`, and the ingest job failed AFTER the
   * email had been fetched and parsed successfully.
   *
   * The failure pointed at transaction.repo, several layers from the cause,
   * which was simply that the categories table had never been seeded. Throwing
   * here names the real problem instead: a missing seed is a broken install,
   * not a per-transaction error to paper over.
   */
  /**
   * Whether an AI decision may be written to the SHARED merchant map.
   *
   * Using a guess for the person who triggered it and publishing that guess as
   * the rule for everyone are different acts, and they deserve different bars.
   *
   * ── Transfers are relationships, not merchants ───────────────────────────
   * A "transfers" result means the counterparty is a person. Writing that to a
   * global table does two bad things. It stores a THIRD PARTY'S NAME — someone
   * who is not a user of this app and never agreed to anything — in a record
   * shared across every account. And it is useless even if shared, because the
   * category describes a relationship between two specific parties rather than
   * a property of a business. Nobody else benefits from knowing that a
   * particular individual is "a transfer".
   *
   * ── A higher bar for speaking on everyone's behalf ───────────────────────
   * 0.6 is enough to label one transaction, which the user can see and correct.
   * A shared row is applied silently to people who will never know it exists,
   * so it takes 0.85.
   */
  private async mayShare(categoryId: string, confidence: number): Promise<boolean> {
    if (confidence < 0.85) return false

    if (this.transfersId === null) {
      this.transfersId = await this.mappingRepo.findCategoryIdByName('transfers')
    }
    return categoryId !== this.transfersId
  }

  private async getUncategorisedId(): Promise<string> {
    if (this.uncategorisedId === null) {
      const id = await this.mappingRepo.findUncategorisedId()
      if (id === null) {
        throw new Error(
          "Category 'uncategorised' is missing. The categories table has not been seeded — run `npm run prisma:seed`.",
        )
      }
      this.uncategorisedId = id
    }
    return this.uncategorisedId
  }

  public async categorize(
    userId: string,
    tier: 'FREE' | 'PRO',
    merchantName: string,
    amountKobo: bigint,
    fingerprint: string,
    /** Which way the money moved. Frequently the deciding fact — the same
     *  counterparty is income on a CREDIT and spending on a DEBIT. */
    direction: 'DEBIT' | 'CREDIT',
  ): Promise<string> {
    const uncategorisedId = await this.getUncategorisedId()

    // ── Tier 1: what THIS user has already told us ────────────────────────
    //
    // Checked FIRST, and this ordering is the whole personalisation story.
    //
    // It used to run second, behind the shared merchant map — which meant an
    // explicit correction was consulted only when no global mapping existed.
    // A user could recategorise the same merchant every month: the correction
    // was saved, correctionCount incremented, and the global mapping won every
    // time. The app recorded that the user disagreed and then ignored them.
    //
    // The principle is that the most specific evidence wins. "This person, this
    // merchant, stated explicitly" beats "inferred once from somebody else's
    // transaction", and no amount of cross-user agreement outranks a user's own
    // decision about their own money.
    const userPref = await this.mappingRepo.findUserPreference(userId, fingerprint)
    if (userPref !== null) {
      return userPref
    }

    // ── Tier 2: what everyone's corrections and the model have established ──
    // A shared map across users. Genuinely useful for real businesses — one
    // person's Shoprite is another's — and applied only where this user has
    // expressed no view of their own.
    const exactMatch = await this.mappingRepo.findMerchantMapping(fingerprint)
    if (exactMatch !== null) {
      return exactMatch
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

        const aiResult = await this.aiProvider.categorize(merchantName, amountKobo, direction)
        if (aiResult.categoryId !== uncategorisedId && aiResult.confidence > 0.6) {
          if (await this.mayShare(aiResult.categoryId, aiResult.confidence)) {
            await this.mappingRepo.saveMerchantMapping(
              fingerprint,
              aiResult.categoryId,
              Math.round(aiResult.confidence * 100),
            )
          }
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
