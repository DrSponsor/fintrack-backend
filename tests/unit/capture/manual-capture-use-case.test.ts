import { describe, expect, it, vi } from 'vitest'
import { ManualCaptureUseCase } from '../../../src/modules/capture/manual/services/manual-capture.use-case'
import type { ITransactionRepository, TransactionRecord } from '../../../src/modules/transactions/repositories/transaction.repo'
import type { IAccountRepository, AccountRecord } from '../../../src/modules/accounts/repositories/account.repo'
import type { ICategoryRepository } from '../../../src/modules/categories/repositories/category.repo'
import { NormalizerService } from '../../../src/modules/transactions/services/normalizer.service'
import { ReconciliationService } from '../../../src/modules/transactions/services/reconciliation.service'
import type { CategorizerService } from '../../../src/modules/transactions/services/categorizer.service'
import { AppError } from '../../../src/core/errors/AppError'
import { randomUUID } from 'node:crypto'

const silentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
  trace: vi.fn(),
  child: () => silentLogger,
} as never

/**
 * Dates are built relative to now, because the schema rejects future dates and
 * anything more than ten years old. A hard-coded literal would pass today and
 * start failing on its own the year it drifts out of range.
 */
const HOURS = 60 * 60 * 1000
const ENTRY_DATE = new Date(Date.now() - 3 * HOURS)

function makeAccountRecord(overrides: Partial<AccountRecord> = {}): AccountRecord {
  return {
    id: randomUUID(),
    userId: 'user-1',
    bankName: 'Guaranty Trust Bank',
    accountLast4: '1234',
    accountType: 'CURRENT',
    captureMethod: 'MANUAL',
    gmailConnected: false,
    balanceKobo: '0',
    lastTransactionDate: null,
    ...overrides,
  }
}

function makeTransactionRecord(overrides: Partial<TransactionRecord> = {}): TransactionRecord {
  return {
    id: randomUUID(),
    accountId: randomUUID(),
    userId: 'user-1',
    amountKobo: '10000',
    type: 'DEBIT',
    merchantName: 'Opay/Shoprite',
    categoryId: randomUUID(),
    transactionDate: ENTRY_DATE,
    source: 'MANUAL',
    isVerified: false,
    createdAt: new Date(),
    ...overrides,
  }
}

function createMockAccountRepo(overrides: Partial<IAccountRepository> = {}): IAccountRepository {
  return {
    create: vi.fn().mockResolvedValue(makeAccountRecord()),
    findByUserId: vi.fn().mockResolvedValue([]),
    findById: vi.fn().mockResolvedValue(makeAccountRecord()),
    update: vi.fn().mockResolvedValue(makeAccountRecord()),
    delete: vi.fn().mockResolvedValue(undefined),
    countByUserId: vi.fn().mockResolvedValue(0),
    updateGmailToken: vi.fn().mockResolvedValue(makeAccountRecord()),
    getGmailToken: vi.fn().mockResolvedValue(null),
    findConnectedGmailAccounts: vi.fn().mockResolvedValue([]),
    ...overrides,
  }
}

function createMockTransactionRepo(overrides: Partial<ITransactionRepository> = {}): ITransactionRepository {
  return {
    create: vi.fn().mockResolvedValue(makeTransactionRecord()),
    findById: vi.fn().mockResolvedValue(null),
    findByUser: vi.fn().mockResolvedValue({ data: [], hasMore: false }),
    findMatchCandidates: vi.fn().mockResolvedValue([]),
    supersede: vi.fn().mockResolvedValue(makeTransactionRecord()),
    findByIdempotencyKey: vi.fn().mockResolvedValue(null),
    deleteManual: vi.fn().mockResolvedValue(undefined),
    correctCategory: vi.fn().mockResolvedValue(0),
    ...overrides,
  }
}

function createMockCategoryRepo(overrides: Partial<ICategoryRepository> = {}): ICategoryRepository {
  return {
    findAll: vi.fn().mockResolvedValue([]),
    findById: vi.fn().mockResolvedValue({ id: randomUUID(), name: 'food-groceries', icon: 'utensils' }),
    findByName: vi.fn().mockResolvedValue(null),
    ...overrides,
  }
}

type BuildOptions = {
  readonly transactionRepo?: ITransactionRepository
  readonly accountRepo?: IAccountRepository
  readonly categoryRepo?: ICategoryRepository
  readonly categorizer?: CategorizerService
}

function build(options: BuildOptions = {}): ManualCaptureUseCase {
  return new ManualCaptureUseCase({
    transactionRepo: options.transactionRepo ?? createMockTransactionRepo(),
    accountRepo: options.accountRepo ?? createMockAccountRepo(),
    categoryRepo: options.categoryRepo ?? createMockCategoryRepo(),
    normalizer: new NormalizerService(),
    categorizer:
      options.categorizer ??
      ({ categorize: vi.fn().mockResolvedValue('guessed-category-id') } as unknown as CategorizerService),
    reconciliation: new ReconciliationService(),
    logger: silentLogger,
  })
}

function makeBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    accountId: randomUUID(),
    amountKobo: '10000',
    type: 'DEBIT',
    merchantName: 'Opay/Shoprite',
    transactionDate: ENTRY_DATE.toISOString(),
    ...overrides,
  }
}

describe('ManualCaptureUseCase', () => {
  it('records a transaction nothing else describes', async () => {
    const account = makeAccountRecord({ userId: 'user-1' })
    const tx = makeTransactionRecord({ accountId: account.id })

    const accountRepo = createMockAccountRepo({ findById: vi.fn().mockResolvedValue(account) })
    const transactionRepo = createMockTransactionRepo({ create: vi.fn().mockResolvedValue(tx) })
    const categorizer = { categorize: vi.fn().mockResolvedValue('food-groceries-id') } as unknown as CategorizerService

    const useCase = build({ accountRepo, transactionRepo, categorizer })
    const result = await useCase.execute(
      'user-1',
      'FREE',
      makeBody({ accountId: account.id, merchantName: '  Opay/Shoprite  ' }),
      'idemp-key',
    )

    expect(result.outcome).toBe('recorded')
    expect(result.transaction).toBe(tx)
    expect(categorizer.categorize).toHaveBeenCalledWith(
      'user-1',
      'FREE',
      'Opay/shoprite',
      10000n,
      'opayshoprite',
      // The user's stated direction reaches the categoriser rather than being
      // inferred later from the sign of an amount.
      'DEBIT',
    )
    expect(transactionRepo.create).toHaveBeenCalledWith({
      accountId: account.id,
      amountKobo: 10000n,
      type: 'DEBIT',
      merchantName: 'Opay/shoprite',
      categoryId: 'food-groceries-id',
      transactionDate: expect.any(Date),
      source: 'MANUAL',
      idempotencyKey: 'idemp-key',
      isVerified: false,
    })
  })

  it('searches for collisions on the exact amount, account and direction', async () => {
    const account = makeAccountRecord({ userId: 'user-1' })
    const accountRepo = createMockAccountRepo({ findById: vi.fn().mockResolvedValue(account) })
    const transactionRepo = createMockTransactionRepo()

    await build({ accountRepo, transactionRepo }).execute(
      'user-1',
      'FREE',
      makeBody({ accountId: account.id }),
      'idemp-key',
    )

    // Amount is passed as an equality, never a range: a payment one kobo away
    // is a different payment.
    expect(transactionRepo.findMatchCandidates).toHaveBeenCalledWith({
      accountId: account.id,
      amountKobo: 10000n,
      type: 'DEBIT',
      from: expect.any(Date),
      to: expect.any(Date),
    })
  })

  it('does not record money the bank already captured', async () => {
    const account = makeAccountRecord({ userId: 'user-1' })
    const existing = makeTransactionRecord({
      accountId: account.id,
      source: 'EMAIL',
      merchantName: 'Shoprite Ikeja City Mall',
      transactionDate: new Date(ENTRY_DATE.getTime() - 20 * 60 * 1000),
    })

    const accountRepo = createMockAccountRepo({ findById: vi.fn().mockResolvedValue(account) })
    const transactionRepo = createMockTransactionRepo({
      findMatchCandidates: vi.fn().mockResolvedValue([existing]),
    })

    const result = await build({ accountRepo, transactionRepo }).execute(
      'user-1',
      'FREE',
      makeBody({ accountId: account.id, merchantName: 'Shoprite' }),
      'idemp-key',
    )

    expect(result.outcome).toBe('already-recorded')
    // The colliding row travels back, because the client has to be able to show
    // the user WHICH payment it means.
    expect(result.transaction.id).toBe(existing.id)
    expect(transactionRepo.create).not.toHaveBeenCalled()
  })

  it('spends nothing on a rejected entry', async () => {
    const account = makeAccountRecord({ userId: 'user-1' })
    const existing = makeTransactionRecord({ accountId: account.id, source: 'EMAIL' })
    const accountRepo = createMockAccountRepo({ findById: vi.fn().mockResolvedValue(account) })
    const transactionRepo = createMockTransactionRepo({
      findMatchCandidates: vi.fn().mockResolvedValue([existing]),
    })
    const categorizer = { categorize: vi.fn() } as unknown as CategorizerService

    await build({ accountRepo, transactionRepo, categorizer }).execute(
      'user-1',
      'FREE',
      makeBody({ accountId: account.id }),
      'idemp-key',
    )

    // The conflict check runs before categorisation, so a duplicate never costs
    // an AI call, a row, an audit event or a balance movement.
    expect(categorizer.categorize).not.toHaveBeenCalled()
  })

  it('records anyway once the user has been shown the duplicate and insisted', async () => {
    const account = makeAccountRecord({ userId: 'user-1' })
    const existing = makeTransactionRecord({ accountId: account.id, source: 'EMAIL' })
    const accountRepo = createMockAccountRepo({ findById: vi.fn().mockResolvedValue(account) })
    const transactionRepo = createMockTransactionRepo({
      findMatchCandidates: vi.fn().mockResolvedValue([existing]),
    })

    const result = await build({ accountRepo, transactionRepo }).execute(
      'user-1',
      'FREE',
      makeBody({ accountId: account.id, force: true }),
      'idemp-key',
    )

    expect(result.outcome).toBe('recorded')
    expect(transactionRepo.create).toHaveBeenCalled()
    // Forcing skips the lookup entirely rather than ignoring its answer.
    expect(transactionRepo.findMatchCandidates).not.toHaveBeenCalled()
  })

  it('asks about an identical amount whose merchant does not match', async () => {
    const account = makeAccountRecord({ userId: 'user-1' })
    const existing = makeTransactionRecord({
      accountId: account.id,
      source: 'MANUAL',
      merchantName: 'Ikeja Electric',
      transactionDate: new Date(ENTRY_DATE.getTime() - 8 * HOURS),
    })

    const accountRepo = createMockAccountRepo({ findById: vi.fn().mockResolvedValue(account) })
    const transactionRepo = createMockTransactionRepo({
      findMatchCandidates: vi.fn().mockResolvedValue([existing]),
    })

    const result = await build({ accountRepo, transactionRepo }).execute(
      'user-1',
      'FREE',
      makeBody({ accountId: account.id, merchantName: 'Shoprite' }),
      'idemp-key',
    )

    expect(result.outcome).toBe('duplicate-suspected')
    expect(result.reason).toContain('merchant does not match')
    expect(transactionRepo.create).not.toHaveBeenCalled()
  })

  it('honours a category the user picked while typing the entry', async () => {
    const account = makeAccountRecord({ userId: 'user-1' })
    const chosen = randomUUID()
    const accountRepo = createMockAccountRepo({ findById: vi.fn().mockResolvedValue(account) })
    const transactionRepo = createMockTransactionRepo()
    const categoryRepo = createMockCategoryRepo({
      findById: vi.fn().mockResolvedValue({ id: chosen, name: 'transport', icon: 'bus' }),
    })
    const categorizer = { categorize: vi.fn() } as unknown as CategorizerService

    await build({ accountRepo, transactionRepo, categoryRepo, categorizer }).execute(
      'user-1',
      'FREE',
      makeBody({ accountId: account.id, categoryId: chosen }),
      'idemp-key',
    )

    // An explicit choice is not second-guessed by the categoriser.
    expect(categorizer.categorize).not.toHaveBeenCalled()
    expect(transactionRepo.create).toHaveBeenCalledWith(expect.objectContaining({ categoryId: chosen }))
  })

  it('rejects a category that does not exist', async () => {
    const account = makeAccountRecord({ userId: 'user-1' })
    const accountRepo = createMockAccountRepo({ findById: vi.fn().mockResolvedValue(account) })
    const categoryRepo = createMockCategoryRepo({ findById: vi.fn().mockResolvedValue(null) })

    await expect(
      build({ accountRepo, categoryRepo }).execute(
        'user-1',
        'FREE',
        makeBody({ accountId: account.id, categoryId: randomUUID() }),
        'idemp-key',
      ),
    ).rejects.toThrow(AppError)
  })

  it('throws NOT_FOUND if the account does not belong to the user', async () => {
    const account = makeAccountRecord({ userId: 'other-user' })
    const accountRepo = createMockAccountRepo({ findById: vi.fn().mockResolvedValue(account) })

    await expect(
      build({ accountRepo }).execute('user-1', 'FREE', makeBody({ accountId: account.id }), 'idemp-key'),
    ).rejects.toThrow(AppError)
  })

  describe('input the ledger must refuse', () => {
    const cases: readonly (readonly [string, Record<string, unknown>])[] = [
      ['a missing merchant and date', { amountKobo: '10000' }],
      ['a zero amount', makeBody({ amountKobo: '0' })],
      // A fat-fingered extra digit is the likeliest way a balance gets poisoned.
      ['an implausibly large amount', makeBody({ amountKobo: '99999999999999' })],
      ['a date in the future', makeBody({ transactionDate: new Date(Date.now() + 48 * HOURS).toISOString() })],
      [
        'a date far enough back to be a parsing accident',
        makeBody({ transactionDate: new Date('1970-01-01T00:00:00.000Z').toISOString() }),
      ],
      // Normalises to an empty fingerprint, which would then collide with every
      // other punctuation-only name in the shared merchant map.
      ['a merchant name with no letters or digits', makeBody({ merchantName: '---' })],
      ['an unknown field', makeBody({ nickname: 'rent money' })],
    ]

    for (const [label, body] of cases) {
      it(`refuses ${label}`, async () => {
        await expect(build().execute('user-1', 'FREE', body, 'idemp-key')).rejects.toThrow(AppError)
      })
    }
  })
})
