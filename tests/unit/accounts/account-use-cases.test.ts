import { describe, expect, it, vi } from 'vitest'
import {
  CreateAccountUseCase,
  ListAccountsUseCase,
  GetAccountUseCase,
  UpdateAccountUseCase,
  DeleteAccountUseCase,
} from '../../../src/modules/accounts/use-cases/account.use-cases'
import type { IAccountRepository, AccountRecord } from '../../../src/modules/accounts/repositories/account.repo'
import { AppError } from '../../../src/core/errors/AppError'
import { ERROR_CODES } from '../../../src/core/errors/codes'
import { randomUUID } from 'node:crypto'

// ──────────────────────────────────────────────────────────────────
// Shared test infrastructure
// ──────────────────────────────────────────────────────────────────

const silentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
  trace: vi.fn(),
  child: () => silentLogger,
} as any

function makeAccount(overrides: Partial<AccountRecord> = {}): AccountRecord {
  return {
    id: randomUUID(),
    userId: '00000000-0000-0000-0000-000000000001',
    bankName: 'Access Bank',
    accountLast4: '4321',
    accountType: 'CURRENT',
    captureMethod: 'MANUAL',
    gmailConnected: false,
    balanceKobo: '0',
    lastTransactionDate: null,
    ...overrides,
  }
}

function createMockAccountRepo(overrides: Partial<IAccountRepository> = {}): IAccountRepository {
  return {
    create: vi.fn().mockResolvedValue(makeAccount()),
    findByUserId: vi.fn().mockResolvedValue([]),
    findById: vi.fn().mockResolvedValue(null),
    update: vi.fn().mockResolvedValue(makeAccount()),
    delete: vi.fn().mockResolvedValue(undefined),
    countByUserId: vi.fn().mockResolvedValue(0),
    ...overrides,
  }
}

// ──────────────────────────────────────────────────────────────────
// CreateAccountUseCase
// ──────────────────────────────────────────────────────────────────

describe('CreateAccountUseCase', () => {
  it('creates an account on valid input', async () => {
    const accountRepo = createMockAccountRepo()
    const useCase = new CreateAccountUseCase({ accountRepo, logger: silentLogger })

    const result = await useCase.execute('user-1', 'FREE', {
      bankName: 'GTBank',
      accountLast4: '1234',
      accountType: 'SAVINGS',
      captureMethod: 'EMAIL',
    })

    expect(result).toBeDefined()
    expect(accountRepo.create).toHaveBeenCalledOnce()
  })

  it('rejects when FREE tier limit (3) is reached', async () => {
    const accountRepo = createMockAccountRepo({
      countByUserId: vi.fn().mockResolvedValue(3),
    })
    const useCase = new CreateAccountUseCase({ accountRepo, logger: silentLogger })

    try {
      await useCase.execute('user-1', 'FREE', {
        bankName: 'GTBank',
        accountLast4: '1234',
        accountType: 'SAVINGS',
        captureMethod: 'EMAIL',
      })
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(AppError)
      expect((err as AppError).code).toBe(ERROR_CODES.FORBIDDEN)
      expect((err as AppError).message).toContain('Upgrade to Pro')
    }
  })

  it('allows PRO tier up to 20 accounts', async () => {
    const accountRepo = createMockAccountRepo({
      countByUserId: vi.fn().mockResolvedValue(19),
    })
    const useCase = new CreateAccountUseCase({ accountRepo, logger: silentLogger })

    const result = await useCase.execute('user-1', 'PRO', {
      bankName: 'GTBank',
      accountLast4: '1234',
      accountType: 'SAVINGS',
      captureMethod: 'EMAIL',
    })

    expect(result).toBeDefined()
  })

  it('rejects invalid accountLast4', async () => {
    const useCase = new CreateAccountUseCase({
      accountRepo: createMockAccountRepo(),
      logger: silentLogger,
    })

    await expect(useCase.execute('user-1', 'FREE', {
      bankName: 'GTBank',
      accountLast4: 'ABCD',
      accountType: 'SAVINGS',
      captureMethod: 'EMAIL',
    })).rejects.toThrow(AppError)
  })
})

// ──────────────────────────────────────────────────────────────────
// GetAccountUseCase — ownership enforcement
// ──────────────────────────────────────────────────────────────────

describe('GetAccountUseCase', () => {
  it('returns account when user owns it', async () => {
    const userId = '00000000-0000-0000-0000-000000000001'
    const account = makeAccount({ userId })
    const accountRepo = createMockAccountRepo({
      findById: vi.fn().mockResolvedValue(account),
    })

    const useCase = new GetAccountUseCase({ accountRepo })
    const result = await useCase.execute(userId, account.id)
    expect(result.id).toBe(account.id)
  })

  it('returns 404 when account belongs to another user (never 403)', async () => {
    const account = makeAccount({ userId: 'other-user-id' })
    const accountRepo = createMockAccountRepo({
      findById: vi.fn().mockResolvedValue(account),
    })

    const useCase = new GetAccountUseCase({ accountRepo })

    try {
      await useCase.execute('requesting-user-id', account.id)
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(AppError)
      // Architecture mandate: 404, NOT 403
      expect((err as AppError).statusCode).toBe(404)
      expect((err as AppError).code).toBe(ERROR_CODES.NOT_FOUND)
    }
  })

  it('returns 404 when account does not exist', async () => {
    const accountRepo = createMockAccountRepo({
      findById: vi.fn().mockResolvedValue(null),
    })

    const useCase = new GetAccountUseCase({ accountRepo })

    await expect(useCase.execute('user-1', 'nonexistent'))
      .rejects
      .toThrow(AppError)
  })
})

// ──────────────────────────────────────────────────────────────────
// DeleteAccountUseCase
// ──────────────────────────────────────────────────────────────────

describe('DeleteAccountUseCase', () => {
  it('deletes an owned account', async () => {
    const userId = 'user-1'
    const account = makeAccount({ userId })
    const accountRepo = createMockAccountRepo({
      findById: vi.fn().mockResolvedValue(account),
    })

    const useCase = new DeleteAccountUseCase({ accountRepo, logger: silentLogger })
    await useCase.execute(userId, account.id)

    expect(accountRepo.delete).toHaveBeenCalledWith(account.id)
  })

  it('returns 404 when trying to delete another user\'s account', async () => {
    const account = makeAccount({ userId: 'other-user' })
    const accountRepo = createMockAccountRepo({
      findById: vi.fn().mockResolvedValue(account),
    })

    const useCase = new DeleteAccountUseCase({ accountRepo, logger: silentLogger })

    await expect(useCase.execute('attacker-id', account.id))
      .rejects
      .toThrow(AppError)
  })
})
