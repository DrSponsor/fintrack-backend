import { describe, expect, it, vi } from 'vitest'
import { ManualCaptureUseCase } from '../../../src/modules/capture/manual/services/manual-capture.use-case'
import type { ITransactionRepository, TransactionRecord } from '../../../src/modules/transactions/repositories/transaction.repo'
import type { IAccountRepository, AccountRecord } from '../../../src/modules/accounts/repositories/account.repo'
import { NormalizerService } from '../../../src/modules/transactions/services/normalizer.service'
import { CategorizerService } from '../../../src/modules/transactions/services/categorizer.service'
import { DeduplicatorService } from '../../../src/modules/transactions/services/deduplicator.service'
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
    transactionDate: new Date(),
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
    ...overrides,
  }
}

function createMockTransactionRepo(overrides: Partial<ITransactionRepository> = {}): ITransactionRepository {
  return {
    create: vi.fn().mockResolvedValue(makeTransactionRecord()),
    findById: vi.fn().mockResolvedValue(null),
    findByUser: vi.fn().mockResolvedValue({ data: [], hasMore: false }),
    correctCategory: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

describe('ManualCaptureUseCase', () => {
  it('successfully captures new manual transaction', async () => {
    const account = makeAccountRecord({ userId: 'user-1' })
    const tx = makeTransactionRecord({ accountId: account.id })

    const accountRepo = createMockAccountRepo({
      findById: vi.fn().mockResolvedValue(account),
    })
    const transactionRepo = createMockTransactionRepo({
      create: vi.fn().mockResolvedValue(tx),
    })
    const normalizer = new NormalizerService()

    const mockCategorizer = {
      categorize: vi.fn().mockResolvedValue('food-groceries-id'),
    } as unknown as CategorizerService

    const mockDeduplicator = {
      getTransactionHash: vi.fn().mockReturnValue('dedup-hash'),
      findDuplicate: vi.fn().mockResolvedValue(null),
      trackTransaction: vi.fn().mockResolvedValue(undefined),
    } as unknown as DeduplicatorService

    const useCase = new ManualCaptureUseCase({
      transactionRepo,
      accountRepo,
      normalizer,
      categorizer: mockCategorizer,
      deduplicator: mockDeduplicator,
      logger: silentLogger,
    })

    const body = {
      accountId: account.id,
      amountKobo: '10000',
      type: 'DEBIT',
      merchantName: '  Opay/Shoprite  ',
      transactionDate: '2026-06-13T20:00:00.000Z',
    }

    const result = await useCase.execute('user-1', 'FREE', body, 'idemp-key')

    expect(result).toBe(tx)
    expect(accountRepo.findById).toHaveBeenCalledWith(account.id)
    expect(mockCategorizer.categorize).toHaveBeenCalledWith(
      'user-1',
      'FREE',
      'Opay/shoprite',
      10000n,
      'opayshoprite',
    )
    expect(mockDeduplicator.getTransactionHash).toHaveBeenCalledWith('1234', 10000n, expect.any(Date))
    expect(mockDeduplicator.findDuplicate).toHaveBeenCalledWith('dedup-hash')
    expect(transactionRepo.create).toHaveBeenCalledWith({
      accountId: account.id,
      amountKobo: 10000n,
      type: 'DEBIT',
      merchantName: 'Opay/shoprite',
      categoryId: 'food-groceries-id',
      transactionDate: expect.any(Date),
      source: 'MANUAL',
      idempotencyKey: 'idemp-key',
    })
    expect(mockDeduplicator.trackTransaction).toHaveBeenCalledWith('dedup-hash', tx.id)
  })

  it('throws NOT_FOUND if account does not belong to user', async () => {
    // Account belongs to other-user
    const account = makeAccountRecord({ userId: 'other-user' })
    const accountRepo = createMockAccountRepo({
      findById: vi.fn().mockResolvedValue(account),
    })

    const useCase = new ManualCaptureUseCase({
      transactionRepo: createMockTransactionRepo(),
      accountRepo,
      normalizer: new NormalizerService(),
      categorizer: {} as any,
      deduplicator: {} as any,
      logger: silentLogger,
    })

    const body = {
      accountId: account.id,
      amountKobo: '10000',
      type: 'DEBIT',
      merchantName: 'Opay/Shoprite',
      transactionDate: '2026-06-13T20:00:00.000Z',
    }

    await expect(useCase.execute('user-1', 'FREE', body, 'idemp-key'))
      .rejects
      .toThrow(AppError)
  })

  it('suppresses and returns existing transaction if duplicate is detected', async () => {
    const account = makeAccountRecord({ userId: 'user-1' })
    const existingTx = makeTransactionRecord({ id: 'existing-tx-id', accountId: account.id })

    const accountRepo = createMockAccountRepo({
      findById: vi.fn().mockResolvedValue(account),
    })
    const transactionRepo = createMockTransactionRepo({
      findById: vi.fn().mockResolvedValue(existingTx),
    })

    const mockDeduplicator = {
      getTransactionHash: vi.fn().mockReturnValue('dedup-hash'),
      findDuplicate: vi.fn().mockResolvedValue('existing-tx-id'),
      trackTransaction: vi.fn(),
    } as unknown as DeduplicatorService

    const mockCategorizer = {
      categorize: vi.fn().mockResolvedValue('cat-id'),
    } as unknown as CategorizerService

    const useCase = new ManualCaptureUseCase({
      transactionRepo,
      accountRepo,
      normalizer: new NormalizerService(),
      categorizer: mockCategorizer,
      deduplicator: mockDeduplicator,
      logger: silentLogger,
    })

    const body = {
      accountId: account.id,
      amountKobo: '10000',
      type: 'DEBIT',
      merchantName: 'Opay/Shoprite',
      transactionDate: '2026-06-13T20:00:00.000Z',
    }

    const result = await useCase.execute('user-1', 'FREE', body, 'idemp-key')

    expect(result.id).toBe('existing-tx-id')
    expect(transactionRepo.create).not.toHaveBeenCalled()
    expect(mockDeduplicator.trackTransaction).not.toHaveBeenCalled()
  })

  it('throws validation error for invalid body inputs', async () => {
    const useCase = new ManualCaptureUseCase({
      transactionRepo: createMockTransactionRepo(),
      accountRepo: createMockAccountRepo(),
      normalizer: new NormalizerService(),
      categorizer: {} as any,
      deduplicator: {} as any,
      logger: silentLogger,
    })

    // Missing required fields
    const body = {
      amountKobo: '10000',
    }

    await expect(useCase.execute('user-1', 'FREE', body, 'idemp-key'))
      .rejects
      .toThrow(AppError)
  })
})
