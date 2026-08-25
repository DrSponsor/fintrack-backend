import { describe, expect, it, vi } from 'vitest'
import { CategorizerService } from '../../../src/modules/transactions/services/categorizer.service'
import type { ICategorizationRepository } from '../../../src/modules/transactions/services/categorizer.service'
import type { IAIProvider } from '../../../src/core/ai/ai-provider.interface'
import { FakeRedis } from '../../helpers/fakes'
import type { Redis } from 'ioredis'

const silentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
  trace: vi.fn(),
  child: () => silentLogger,
} as any

function createMockMappingRepo(overrides: Partial<ICategorizationRepository> = {}): ICategorizationRepository {
  return {
    findMerchantMapping: vi.fn().mockResolvedValue(null),
    findKeywordMappings: vi.fn().mockResolvedValue([]),
    findUserPreference: vi.fn().mockResolvedValue(null),
    saveMerchantMapping: vi.fn().mockResolvedValue(undefined),
    findUncategorisedId: vi.fn().mockResolvedValue('uncategorised-id'),
    findCategoryIdByName: vi.fn().mockResolvedValue('transfers-id'),
    ...overrides,
  }
}

function createMockAIProvider(overrides: Partial<IAIProvider> = {}): IAIProvider {
  return {
    providerName: 'deepseek',
    categorize: vi.fn().mockResolvedValue({ categoryId: 'uncategorised-id', confidence: 0 }),
    generateInsightNarrative: vi.fn().mockResolvedValue(''),
    generateParserPattern: vi.fn().mockResolvedValue({}),
    ...overrides,
  }
}

describe('CategorizerService', () => {
  it('Tier 2: uses the shared merchant map when the user has no preference', async () => {
    const mappingRepo = createMockMappingRepo({
      findMerchantMapping: vi.fn().mockResolvedValue('food-groceries-id'),
    })
    const service = new CategorizerService({
      mappingRepo,
      aiProvider: createMockAIProvider(),
      redis: new FakeRedis() as unknown as Redis,
      logger: silentLogger,
    })

    const result = await service.categorize('user-1', 'FREE', 'Opay/Shoprite', 1000n, 'opayshoprite', 'DEBIT')
    expect(result).toBe('food-groceries-id')
    expect(mappingRepo.findMerchantMapping).toHaveBeenCalledWith('opayshoprite')
  })

  it('Tier 1: uses the user preference before anything shared', async () => {
    const mappingRepo = createMockMappingRepo({
      findMerchantMapping: vi.fn().mockResolvedValue(null),
      findUserPreference: vi.fn().mockResolvedValue('subscriptions-id'),
    })
    const service = new CategorizerService({
      mappingRepo,
      aiProvider: createMockAIProvider(),
      redis: new FakeRedis() as unknown as Redis,
      logger: silentLogger,
    })

    const result = await service.categorize('user-1', 'FREE', 'Netflix', 1000n, 'netflix', 'DEBIT')
    expect(result).toBe('subscriptions-id')
    expect(mappingRepo.findUserPreference).toHaveBeenCalledWith('user-1', 'netflix')
  })

  it('Tier 3: uses keyword mapping match if first two fail', async () => {
    const mappingRepo = createMockMappingRepo({
      findMerchantMapping: vi.fn().mockResolvedValue(null),
      findUserPreference: vi.fn().mockResolvedValue(null),
      findKeywordMappings: vi.fn().mockResolvedValue([
        { keyword: 'uber', categoryId: 'transport-id' },
        { keyword: 'grocery', categoryId: 'food-groceries-id' },
      ]),
    })
    const service = new CategorizerService({
      mappingRepo,
      aiProvider: createMockAIProvider(),
      redis: new FakeRedis() as unknown as Redis,
      logger: silentLogger,
    })

    const result = await service.categorize('user-1', 'FREE', 'Uber Lagos Ride', 1000n, 'uberlagosride', 'DEBIT')
    expect(result).toBe('transport-id')
  })

  it('Tier 4: calls AI provider when limit is not reached and confidence is high', async () => {
    const mappingRepo = createMockMappingRepo({
      findMerchantMapping: vi.fn().mockResolvedValue(null),
      findUserPreference: vi.fn().mockResolvedValue(null),
      findKeywordMappings: vi.fn().mockResolvedValue([]),
    })
    const aiProvider = createMockAIProvider({
      categorize: vi.fn().mockResolvedValue({ categoryId: 'entertainment-id', confidence: 0.85 }),
    })
    const service = new CategorizerService({
      mappingRepo,
      aiProvider,
      redis: new FakeRedis() as unknown as Redis,
      logger: silentLogger,
    })

    const result = await service.categorize('user-1', 'FREE', 'Showmax Subscription', 5000n, 'showmax', 'DEBIT')
    expect(result).toBe('entertainment-id')
    // Direction is passed through to the model: the same counterparty means
    // different things depending on which way the money moved.
    expect(aiProvider.categorize).toHaveBeenCalledWith('Showmax Subscription', 5000n, 'DEBIT')
    expect(mappingRepo.saveMerchantMapping).toHaveBeenCalledWith('showmax', 'entertainment-id', 85)
  })

  it('Tier 4: does not save merchant mapping if AI confidence is low', async () => {
    const mappingRepo = createMockMappingRepo({
      findMerchantMapping: vi.fn().mockResolvedValue(null),
      findUserPreference: vi.fn().mockResolvedValue(null),
      findKeywordMappings: vi.fn().mockResolvedValue([]),
    })
    const aiProvider = createMockAIProvider({
      categorize: vi.fn().mockResolvedValue({ categoryId: 'entertainment-id', confidence: 0.4 }),
    })
    const service = new CategorizerService({
      mappingRepo,
      aiProvider,
      redis: new FakeRedis() as unknown as Redis,
      logger: silentLogger,
    })

    const result = await service.categorize('user-1', 'FREE', 'Showmax Subscription', 5000n, 'showmax', 'DEBIT')
    // Fallback because AI confidence (0.4) <= 0.6
    expect(result).toBe('uncategorised-id')
    expect(mappingRepo.saveMerchantMapping).not.toHaveBeenCalled()
  })

  it('Tier 4: bypasses AI when user monthly limit is reached', async () => {
    const mappingRepo = createMockMappingRepo({
      findMerchantMapping: vi.fn().mockResolvedValue(null),
      findUserPreference: vi.fn().mockResolvedValue(null),
      findKeywordMappings: vi.fn().mockResolvedValue([]),
    })
    const aiProvider = createMockAIProvider({
      categorize: vi.fn().mockResolvedValue({ categoryId: 'entertainment-id', confidence: 0.9 }),
    })

    const redis = new FakeRedis() as unknown as Redis
    const now = new Date()
    const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
    // Free tier limit is 50 calls
    await redis.set(`ai:calls:user-1:${yearMonth}`, '50')

    const service = new CategorizerService({
      mappingRepo,
      aiProvider,
      redis,
      logger: silentLogger,
    })

    const result = await service.categorize('user-1', 'FREE', 'Showmax Subscription', 5000n, 'showmax', 'DEBIT')
    expect(result).toBe('uncategorised-id')
    expect(aiProvider.categorize).not.toHaveBeenCalled()
  })
})

describe('CategorizerService — personalisation', () => {
  const build = (mappingRepo: ICategorizationRepository, aiProvider: IAIProvider) =>
    new CategorizerService({
      mappingRepo,
      aiProvider,
      redis: new FakeRedis() as unknown as Redis,
      logger: silentLogger,
    })

  it("a user's own correction beats the shared merchant map", async () => {
    // The ordering bug this guards against was silent and permanent: the
    // shared map was consulted first and returned early, so an explicit
    // correction was stored, counted, and then never read. The user could
    // recategorise the same merchant forever without anything changing.
    const mappingRepo = createMockMappingRepo({
      findUserPreference: vi.fn().mockResolvedValue('food-groceries-id'),
      findMerchantMapping: vi.fn().mockResolvedValue('shopping-id'),
    })
    const service = build(mappingRepo, createMockAIProvider())

    const result = await service.categorize('user-1', 'FREE', 'Shoprite', 5000n, 'shoprite', 'DEBIT')
    expect(result).toBe('food-groceries-id')
    // The shared map must not even be consulted once the user has spoken.
    expect(mappingRepo.findMerchantMapping).not.toHaveBeenCalled()
  })

  it('does not publish a transfer to the shared map, because that is a person', async () => {
    // "transfers" means the counterparty is an individual. Writing it globally
    // would store a third party's name in a table shared with every other user,
    // and would be useless to them anyway — the category describes a
    // relationship, not a business.
    const mappingRepo = createMockMappingRepo({
      findCategoryIdByName: vi.fn().mockResolvedValue('transfers-id'),
    })
    const aiProvider = createMockAIProvider({
      categorize: vi.fn().mockResolvedValue({ categoryId: 'transfers-id', confidence: 0.95 }),
    })
    const service = build(mappingRepo, aiProvider)

    const result = await service.categorize('user-1', 'FREE', 'Mary Okafor Roe', 950000n, 'maryokaforroe', 'DEBIT')
    // Still used for THIS user — only the sharing is withheld.
    expect(result).toBe('transfers-id')
    expect(mappingRepo.saveMerchantMapping).not.toHaveBeenCalled()
  })

  it('uses a moderately confident answer without publishing it to everyone', async () => {
    // Labelling one visible, correctable transaction and writing a rule that is
    // applied silently to strangers are different acts, so they take different
    // bars: 0.6 to use, 0.85 to share.
    const mappingRepo = createMockMappingRepo()
    const aiProvider = createMockAIProvider({
      categorize: vi.fn().mockResolvedValue({ categoryId: 'transport-id', confidence: 0.7 }),
    })
    const service = build(mappingRepo, aiProvider)

    const result = await service.categorize('user-1', 'FREE', 'Some Ride Co', 5000n, 'someride', 'DEBIT')
    expect(result).toBe('transport-id')
    expect(mappingRepo.saveMerchantMapping).not.toHaveBeenCalled()
  })

  it('publishes a confident answer about a real business', async () => {
    const mappingRepo = createMockMappingRepo()
    const aiProvider = createMockAIProvider({
      categorize: vi.fn().mockResolvedValue({ categoryId: 'subscriptions-id', confidence: 0.95 }),
    })
    const service = build(mappingRepo, aiProvider)

    const result = await service.categorize('user-1', 'FREE', 'Spotify', 160000n, 'spotify', 'DEBIT')
    expect(result).toBe('subscriptions-id')
    expect(mappingRepo.saveMerchantMapping).toHaveBeenCalledWith('spotify', 'subscriptions-id', 95)
  })
})
