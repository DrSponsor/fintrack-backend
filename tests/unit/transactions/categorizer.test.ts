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
  it('Tier 1: uses exact merchant mapping if found', async () => {
    const mappingRepo = createMockMappingRepo({
      findMerchantMapping: vi.fn().mockResolvedValue('food-groceries-id'),
    })
    const service = new CategorizerService({
      mappingRepo,
      aiProvider: createMockAIProvider(),
      redis: new FakeRedis() as unknown as Redis,
      logger: silentLogger,
    })

    const result = await service.categorize('user-1', 'FREE', 'Opay/Shoprite', 1000n, 'opayshoprite')
    expect(result).toBe('food-groceries-id')
    expect(mappingRepo.findMerchantMapping).toHaveBeenCalledWith('opayshoprite')
  })

  it('Tier 2: uses user preference mapping if exact match fails', async () => {
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

    const result = await service.categorize('user-1', 'FREE', 'Netflix', 1000n, 'netflix')
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

    const result = await service.categorize('user-1', 'FREE', 'Uber Lagos Ride', 1000n, 'uberlagosride')
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

    const result = await service.categorize('user-1', 'FREE', 'Showmax Subscription', 5000n, 'showmax')
    expect(result).toBe('entertainment-id')
    expect(aiProvider.categorize).toHaveBeenCalledWith('Showmax Subscription', 5000n)
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

    const result = await service.categorize('user-1', 'FREE', 'Showmax Subscription', 5000n, 'showmax')
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

    const result = await service.categorize('user-1', 'FREE', 'Showmax Subscription', 5000n, 'showmax')
    expect(result).toBe('uncategorised-id')
    expect(aiProvider.categorize).not.toHaveBeenCalled()
  })
})
