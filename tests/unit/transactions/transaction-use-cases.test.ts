import { describe, expect, it, vi } from 'vitest'
import {
  ListTransactionsUseCase,
  GetTransactionUseCase,
  CorrectCategoryUseCase,
  DeleteTransactionUseCase,
} from '../../../src/modules/transactions/use-cases/transaction.use-cases'
import type { ITransactionRepository, TransactionRecord } from '../../../src/modules/transactions/repositories/transaction.repo'
import type { ICategoryRepository } from '../../../src/modules/categories/repositories/category.repo'
import { NormalizerService } from '../../../src/modules/transactions/services/normalizer.service'
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
} as any

function makeTransactionRecord(overrides: Partial<TransactionRecord> = {}): TransactionRecord {
  return {
    id: randomUUID(),
    accountId: randomUUID(),
    userId: 'user-1',
    amountKobo: '5000',
    type: 'DEBIT',
    merchantName: 'Opay Nigeria Ltd',
    categoryId: randomUUID(),
    transactionDate: new Date(),
    source: 'MANUAL',
    isVerified: false,
    providerRef: null,
    createdAt: new Date(),
    ...overrides,
  }
}

function createMockTransactionRepo(overrides: Partial<ITransactionRepository> = {}): ITransactionRepository {
  return {
    create: vi.fn().mockResolvedValue(makeTransactionRecord()),
    findById: vi.fn().mockResolvedValue(makeTransactionRecord()),
    findByUser: vi.fn().mockResolvedValue({ data: [], hasMore: false }),
    findMatchCandidates: vi.fn().mockResolvedValue([]),
    supersede: vi.fn().mockResolvedValue(makeTransactionRecord()),
    findByIdempotencyKey: vi.fn().mockResolvedValue(null),
    findByProviderRef: vi.fn().mockResolvedValue([]),
    deleteManual: vi.fn().mockResolvedValue(undefined),
    // Resolves the count of backfilled rows, not undefined.
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

describe('ListTransactionsUseCase', () => {
  it('calls transactionRepo.findByUser with correct parameters', async () => {
    const transactionRepo = createMockTransactionRepo({
      findByUser: vi.fn().mockResolvedValue({ data: [makeTransactionRecord()], hasMore: false }),
    })
    const useCase = new ListTransactionsUseCase({ transactionRepo })
    const result = await useCase.execute('user-1', { limit: 10, type: 'DEBIT' })

    expect(result.data).toHaveLength(1)
    expect(transactionRepo.findByUser).toHaveBeenCalledWith('user-1', undefined, 10, { type: 'DEBIT' })
  })

  it('validates and converts date strings to Dates', async () => {
    const transactionRepo = createMockTransactionRepo()
    const useCase = new ListTransactionsUseCase({ transactionRepo })
    await useCase.execute('user-1', { startDate: '2026-06-13T00:00:00.000Z' })

    expect(transactionRepo.findByUser).toHaveBeenCalledWith(
      'user-1',
      undefined,
      20,
      { startDate: expect.any(Date) },
    )
  })

  it('throws validation error for invalid query parameters', async () => {
    const useCase = new ListTransactionsUseCase({ transactionRepo: createMockTransactionRepo() })
    await expect(useCase.execute('user-1', { limit: -5 })).rejects.toThrow(AppError)
  })
})

describe('GetTransactionUseCase', () => {
  it('returns transaction if ownership is correct', async () => {
    const tx = makeTransactionRecord({ userId: 'user-1' })
    const transactionRepo = createMockTransactionRepo({
      findById: vi.fn().mockResolvedValue(tx),
    })
    const useCase = new GetTransactionUseCase({ transactionRepo })
    const result = await useCase.execute('user-1', tx.id)

    expect(result.id).toBe(tx.id)
  })

  it('throws NOT_FOUND if transaction belongs to another user', async () => {
    const tx = makeTransactionRecord({ userId: 'other-user' })
    const transactionRepo = createMockTransactionRepo({
      findById: vi.fn().mockResolvedValue(tx),
    })
    const useCase = new GetTransactionUseCase({ transactionRepo })

    await expect(useCase.execute('user-1', tx.id))
      .rejects
      .toThrow(AppError)
  })

  it('throws NOT_FOUND if transaction does not exist', async () => {
    const transactionRepo = createMockTransactionRepo({
      findById: vi.fn().mockResolvedValue(null),
    })
    const useCase = new GetTransactionUseCase({ transactionRepo })

    await expect(useCase.execute('user-1', 'missing-id'))
      .rejects
      .toThrow(AppError)
  })
})

describe('CorrectCategoryUseCase', () => {
  it('corrects category when category and transaction exist and belong to user', async () => {
    const categoryId = randomUUID()
    const tx = makeTransactionRecord({ userId: 'user-1' })

    const categoryRepo = createMockCategoryRepo({
      findById: vi.fn().mockResolvedValue({ id: categoryId, name: 'food', icon: 'utensils' }),
    })
    const transactionRepo = createMockTransactionRepo({
      findById: vi.fn().mockResolvedValue(tx),
    })
    const normalizer = new NormalizerService()

    const useCase = new CorrectCategoryUseCase({
      transactionRepo,
      categoryRepo,
      normalizer,
      logger: silentLogger,
    })

    await useCase.execute('user-1', tx.id, { categoryId })

    expect(transactionRepo.correctCategory).toHaveBeenCalledWith(
      tx.id,
      categoryId,
      'user-1',
      expect.any(String),
      // No scope was requested and the row is not a transfer (findByName is
      // mocked to null), so the correction reaches the whole merchant.
      'merchant',
    )
  })

  it('keeps a correction to a single row when the transaction is a transfer', async () => {
    // The counterparty is a person, and a person's category is not stable:
    // money sent to the same individual can be food this week and a thrift
    // contribution the next. Spreading one correction across all of them —
    // forwards or backwards — would be confidently wrong.
    const categoryId = randomUUID()
    const transfersId = randomUUID()
    const tx = makeTransactionRecord({ userId: 'user-1', categoryId: transfersId })

    const transactionRepo = createMockTransactionRepo({
      findById: vi.fn().mockResolvedValue(tx),
    })
    const categoryRepo = createMockCategoryRepo({
      findById: vi.fn().mockResolvedValue({ id: categoryId, name: 'food-groceries', icon: 'utensils' }),
      findByName: vi.fn().mockResolvedValue({ id: transfersId, name: 'transfers', icon: 'swap' }),
    })

    const useCase = new CorrectCategoryUseCase({
      transactionRepo,
      categoryRepo,
      normalizer: new NormalizerService(),
      logger: silentLogger,
    })

    const result = await useCase.execute('user-1', tx.id, { categoryId })

    expect(result.scope).toBe('transaction')
    expect(transactionRepo.correctCategory).toHaveBeenCalledWith(
      tx.id,
      categoryId,
      'user-1',
      expect.any(String),
      'transaction',
    )
  })

  it('honours an explicit scope over the inferred default', async () => {
    const categoryId = randomUUID()
    const transfersId = randomUUID()
    const tx = makeTransactionRecord({ userId: 'user-1', categoryId: transfersId })

    const transactionRepo = createMockTransactionRepo({
      findById: vi.fn().mockResolvedValue(tx),
      correctCategory: vi.fn().mockResolvedValue(11),
    })
    const categoryRepo = createMockCategoryRepo({
      findById: vi.fn().mockResolvedValue({ id: categoryId, name: 'food-groceries', icon: 'utensils' }),
      findByName: vi.fn().mockResolvedValue({ id: transfersId, name: 'transfers', icon: 'swap' }),
    })

    const useCase = new CorrectCategoryUseCase({
      transactionRepo,
      categoryRepo,
      normalizer: new NormalizerService(),
      logger: silentLogger,
    })

    // The user overrules the cautious default: they know this particular
    // counterparty always means the same thing to them.
    const result = await useCase.execute('user-1', tx.id, { categoryId, scope: 'merchant' })

    expect(result.scope).toBe('merchant')
    // Reported back so the response can say what happened rather than
    // rewriting eleven rows of history silently.
    expect(result.backfilled).toBe(11)
  })

  it('throws NOT_FOUND if category does not exist', async () => {
    const categoryRepo = createMockCategoryRepo({
      findById: vi.fn().mockResolvedValue(null),
    })
    const useCase = new CorrectCategoryUseCase({
      transactionRepo: createMockTransactionRepo(),
      categoryRepo,
      normalizer: new NormalizerService(),
      logger: silentLogger,
    })

    await expect(useCase.execute('user-1', 'tx-id', { categoryId: randomUUID() }))
      .rejects
      .toThrow(AppError)
  })

  it('throws NOT_FOUND if transaction does not exist or belongs to another user', async () => {
    const tx = makeTransactionRecord({ userId: 'other-user' })
    const categoryId = randomUUID()
    const categoryRepo = createMockCategoryRepo({
      findById: vi.fn().mockResolvedValue({ id: categoryId, name: 'food', icon: 'utensils' }),
    })
    const transactionRepo = createMockTransactionRepo({
      findById: vi.fn().mockResolvedValue(tx),
    })
    const useCase = new CorrectCategoryUseCase({
      transactionRepo,
      categoryRepo,
      normalizer: new NormalizerService(),
      logger: silentLogger,
    })

    await expect(useCase.execute('user-1', tx.id, { categoryId }))
      .rejects
      .toThrow(AppError)
  })
})

describe('DeleteTransactionUseCase', () => {
  it('removes a transaction the user entered themselves', async () => {
    const tx = makeTransactionRecord({ userId: 'user-1', source: 'MANUAL' })
    const transactionRepo = createMockTransactionRepo({
      findById: vi.fn().mockResolvedValue(tx),
    })

    await new DeleteTransactionUseCase({ transactionRepo, logger: silentLogger }).execute('user-1', tx.id)

    expect(transactionRepo.deleteManual).toHaveBeenCalledWith(tx.id)
  })

  it('refuses to delete a transaction that came from the bank', async () => {
    // A bank-sourced row records something that actually happened. Deleting one
    // would stop totals reconciling with the bank, and would be
    // indistinguishable afterwards from the payment never existing.
    const tx = makeTransactionRecord({ userId: 'user-1', source: 'EMAIL' })
    const transactionRepo = createMockTransactionRepo({
      findById: vi.fn().mockResolvedValue(tx),
    })

    await expect(
      new DeleteTransactionUseCase({ transactionRepo, logger: silentLogger }).execute('user-1', tx.id),
    ).rejects.toThrow(AppError)
    expect(transactionRepo.deleteManual).not.toHaveBeenCalled()
  })

  it('does not reveal that another user\u2019s transaction exists', async () => {
    const tx = makeTransactionRecord({ userId: 'someone-else', source: 'MANUAL' })
    const transactionRepo = createMockTransactionRepo({
      findById: vi.fn().mockResolvedValue(tx),
    })

    await expect(
      new DeleteTransactionUseCase({ transactionRepo, logger: silentLogger }).execute('user-1', tx.id),
    ).rejects.toThrow(AppError)
    expect(transactionRepo.deleteManual).not.toHaveBeenCalled()
  })
})
