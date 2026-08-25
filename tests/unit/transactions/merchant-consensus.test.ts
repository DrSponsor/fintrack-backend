import { describe, expect, it, vi } from 'vitest'
import {
  MerchantConsensusService,
  CONSENSUS_THRESHOLD,
} from '../../../src/modules/transactions/services/merchant-consensus.service'
import type {
  IConsensusRepository,
  CategoryVote,
  ExistingMapping,
} from '../../../src/modules/transactions/services/merchant-consensus.service'

const silentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
  trace: vi.fn(),
  child: () => silentLogger,
} as never

const TRANSFERS = 'transfers-id'

function createRepo(overrides: Partial<IConsensusRepository> = {}): IConsensusRepository {
  return {
    tallyPreferences: vi.fn().mockResolvedValue([] as readonly CategoryVote[]),
    findMapping: vi.fn().mockResolvedValue(null as ExistingMapping | null),
    promoteMapping: vi.fn().mockResolvedValue(undefined),
    findCategoryIdByName: vi.fn().mockResolvedValue(TRANSFERS),
    ...overrides,
  }
}

const build = (repo: IConsensusRepository) => new MerchantConsensusService({ repo, logger: silentLogger })

describe('MerchantConsensusService', () => {
  it('promotes once enough separate users agree', async () => {
    const repo = createRepo({
      tallyPreferences: vi.fn().mockResolvedValue([{ categoryId: 'food-id', users: CONSENSUS_THRESHOLD }]),
    })
    const result = await build(repo).evaluate('shoprite')

    expect(result.promoted).toBe(true)
    expect(repo.promoteMapping).toHaveBeenCalledWith('shoprite', 'food-id', CONSENSUS_THRESHOLD)
  })

  it('does not promote below the threshold', async () => {
    const repo = createRepo({
      tallyPreferences: vi.fn().mockResolvedValue([{ categoryId: 'food-id', users: CONSENSUS_THRESHOLD - 1 }]),
    })
    const result = await build(repo).evaluate('shoprite')

    expect(result.promoted).toBe(false)
    expect(repo.promoteMapping).not.toHaveBeenCalled()
  })

  it('does not promote a contested merchant even when the leader clears the threshold', async () => {
    // Four users say shopping and five say food-groceries. The leader has the
    // most votes but not a majority, which is what a genuinely ambiguous
    // merchant looks like — a supermarket that also sells fuel. Everyone's own
    // preference should keep winning instead.
    const repo = createRepo({
      tallyPreferences: vi.fn().mockResolvedValue([
        { categoryId: 'food-id', users: 5 },
        { categoryId: 'shopping-id', users: 4 },
        { categoryId: 'transport-id', users: 3 },
      ]),
    })
    const result = await build(repo).evaluate('bigstore')

    expect(result.promoted).toBe(false)
    if (!result.promoted) expect(result.reason).toContain('contested')
    expect(repo.promoteMapping).not.toHaveBeenCalled()
  })

  it('never promotes transfers, because that means the counterparty is a person', async () => {
    // A global row would put a private individual's name in a table every
    // account reads, and would be meaningless to them anyway.
    const repo = createRepo({
      tallyPreferences: vi.fn().mockResolvedValue([{ categoryId: TRANSFERS, users: 10 }]),
    })
    const result = await build(repo).evaluate('maryokaforroe')

    expect(result.promoted).toBe(false)
    if (!result.promoted) expect(result.reason).toContain('relationships')
    expect(repo.promoteMapping).not.toHaveBeenCalled()
  })

  it('overturns an AI-generated mapping the crowd disagrees with', async () => {
    // The whole point: a wrong model guess gets fixed for everyone, rather than
    // every user working around it separately.
    const repo = createRepo({
      tallyPreferences: vi.fn().mockResolvedValue([{ categoryId: 'food-id', users: 4 }]),
      findMapping: vi.fn().mockResolvedValue({ categoryId: 'shopping-id', source: 'AI_CONFIRMED' }),
    })
    const result = await build(repo).evaluate('shoprite')

    expect(result.promoted).toBe(true)
    expect(repo.promoteMapping).toHaveBeenCalledWith('shoprite', 'food-id', 4)
  })

  it('leaves a seeded mapping alone, however many users disagree', async () => {
    // Curated data is not silently reversed by a crowd. The disagreement is
    // logged so a human can look at it.
    const repo = createRepo({
      tallyPreferences: vi.fn().mockResolvedValue([{ categoryId: 'food-id', users: 9 }]),
      findMapping: vi.fn().mockResolvedValue({ categoryId: 'shopping-id', source: 'SEEDED' }),
    })
    const result = await build(repo).evaluate('shoprite')

    expect(result.promoted).toBe(false)
    if (!result.promoted) expect(result.reason).toContain('curated')
    expect(repo.promoteMapping).not.toHaveBeenCalled()
  })

  it('refreshes the confirmation count when the mapping already agrees', async () => {
    const repo = createRepo({
      tallyPreferences: vi.fn().mockResolvedValue([{ categoryId: 'food-id', users: 7 }]),
      findMapping: vi.fn().mockResolvedValue({ categoryId: 'food-id', source: 'USER_CORRECTION' }),
    })
    const result = await build(repo).evaluate('shoprite')

    // Nothing changed category, but how well established it is did.
    expect(result.promoted).toBe(false)
    expect(repo.promoteMapping).toHaveBeenCalledWith('shoprite', 'food-id', 7)
  })

  it('does nothing when no preferences exist', async () => {
    const repo = createRepo()
    const result = await build(repo).evaluate('unknown')

    expect(result.promoted).toBe(false)
    expect(repo.promoteMapping).not.toHaveBeenCalled()
  })
})
