import { notFound, validationError } from '../../../core/errors/factories'
import type { ITransactionRepository, TransactionRecord, ListTransactionsFilter } from '../repositories/transaction.repo'
import type { ICategoryRepository } from '../../categories/repositories/category.repo'
import type { NormalizerService } from '../services/normalizer.service'
import { listTransactionsQuerySchema, correctCategoryBodySchema } from '../schemas/transaction.schemas'
import type { AppLogger } from '../../../core/logger'

export type TransactionUseCasesDeps = {
  readonly transactionRepo: ITransactionRepository
  readonly categoryRepo?: ICategoryRepository
  readonly normalizer?: NormalizerService
  readonly logger?: AppLogger
}

export class ListTransactionsUseCase {
  private readonly transactionRepo: ITransactionRepository

  public constructor(deps: Pick<TransactionUseCasesDeps, 'transactionRepo'>) {
    this.transactionRepo = deps.transactionRepo
  }

  public async execute(
    userId: string,
    rawQuery: unknown,
  ): Promise<{ readonly data: readonly TransactionRecord[]; readonly hasMore: boolean }> {
    const parsed = listTransactionsQuerySchema.safeParse(rawQuery)
    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0]
      throw validationError(
        firstIssue?.message ?? 'Validation failed',
        firstIssue?.path[0] !== undefined ? String(firstIssue.path[0]) : undefined,
      )
    }

    const { cursor, limit, accountId, categoryId, type, startDate, endDate } = parsed.data

    const filters: ListTransactionsFilter = {
      ...(accountId ? { accountId } : {}),
      ...(categoryId ? { categoryId } : {}),
      ...(type ? { type } : {}),
      ...(startDate ? { startDate: new Date(startDate) } : {}),
      ...(endDate ? { endDate: new Date(endDate) } : {}),
    }

    return this.transactionRepo.findByUser(userId, cursor, limit, filters)
  }
}

export class GetTransactionUseCase {
  private readonly transactionRepo: ITransactionRepository

  public constructor(deps: Pick<TransactionUseCasesDeps, 'transactionRepo'>) {
    this.transactionRepo = deps.transactionRepo
  }

  public async execute(userId: string, transactionId: string): Promise<TransactionRecord> {
    const transaction = await this.transactionRepo.findById(transactionId)
    // Security Layer: 404 instead of 403 on ownership mismatch to deny existence
    if (transaction === null || transaction.userId !== userId) {
      throw notFound('Transaction not found')
    }
    return transaction
  }
}

export class CorrectCategoryUseCase {
  private readonly transactionRepo: ITransactionRepository
  private readonly categoryRepo: ICategoryRepository
  private readonly normalizer: NormalizerService
  private readonly logger: AppLogger

  public constructor(deps: Required<TransactionUseCasesDeps>) {
    this.transactionRepo = deps.transactionRepo
    this.categoryRepo = deps.categoryRepo
    this.normalizer = deps.normalizer
    this.logger = deps.logger
  }

  public async execute(userId: string, transactionId: string, rawBody: unknown): Promise<void> {
    const parsed = correctCategoryBodySchema.safeParse(rawBody)
    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0]
      throw validationError(
        firstIssue?.message ?? 'Validation failed',
        firstIssue?.path[0] !== undefined ? String(firstIssue.path[0]) : undefined,
      )
    }

    const { categoryId } = parsed.data

    // Check category exists
    const category = await this.categoryRepo.findById(categoryId)
    if (category === null) {
      throw notFound('Category not found')
    }

    // Check transaction exists and belongs to the user
    const transaction = await this.transactionRepo.findById(transactionId)
    if (transaction === null || transaction.userId !== userId) {
      throw notFound('Transaction not found')
    }

    const normalizedMerchant = this.normalizer.normalizeMerchantName(transaction.merchantName)
    const fingerprint = this.normalizer.getMerchantFingerprint(normalizedMerchant)

    await this.transactionRepo.correctCategory(transactionId, categoryId, userId, fingerprint)
    this.logger.info({ userId, transactionId, categoryId }, 'transaction category corrected')
  }
}
