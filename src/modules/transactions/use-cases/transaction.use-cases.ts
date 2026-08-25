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

  /**
   * Returns the reach that was applied and how many earlier transactions were
   * changed, so the response can say what happened. "Also updated 11 earlier
   * transactions" is information the user needs; silently rewriting history is
   * not something to do without telling them.
   */
  public async execute(
    userId: string,
    transactionId: string,
    rawBody: unknown,
  ): Promise<{ readonly scope: 'transaction' | 'merchant'; readonly backfilled: number }> {
    const parsed = correctCategoryBodySchema.safeParse(rawBody)
    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0]
      throw validationError(
        firstIssue?.message ?? 'Validation failed',
        firstIssue?.path[0] !== undefined ? String(firstIssue.path[0]) : undefined,
      )
    }

    const { categoryId, scope } = parsed.data

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

    const effectiveScope = scope ?? (await this.defaultScope(transaction.categoryId))

    const backfilled = await this.transactionRepo.correctCategory(
      transactionId,
      categoryId,
      userId,
      fingerprint,
      effectiveScope,
    )
    this.logger.info(
      { userId, transactionId, categoryId, scope: effectiveScope, backfilled },
      'transaction category corrected',
    )
    return { scope: effectiveScope, backfilled }
  }

  /**
   * Chooses a reach when the client did not state one.
   *
   * The question is whether the counterparty determines the category. For a
   * business it generally does. For an individual it does not — the same person
   * can receive money for food one week and a thrift contribution the next — so
   * a correction there describes THIS payment, not the relationship.
   *
   * A row sitting in `transfers` is the signal that the counterparty is a
   * person, since that is precisely what the categoriser uses the category for.
   *
   * When in doubt this picks the narrow option, because the two mistakes are
   * not equally costly: a correction that failed to spread is visible the next
   * time the user looks at that merchant, while an unwanted rewrite of months
   * of history is nearly invisible and destroys data the user never revisited.
   */
  private async defaultScope(currentCategoryId: string): Promise<'transaction' | 'merchant'> {
    const transfers = await this.categoryRepo.findByName('transfers')
    if (transfers !== null && transfers.id === currentCategoryId) return 'transaction'
    return 'merchant'
  }
}
