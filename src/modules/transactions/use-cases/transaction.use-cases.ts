import { notFound, validationError } from '../../../core/errors/factories'
import type { ITransactionRepository, TransactionRecord, ListTransactionsFilter } from '../repositories/transaction.repo'
import type { ICategoryRepository } from '../../categories/repositories/category.repo'
import type { NormalizerService } from '../services/normalizer.service'
import type { MerchantConsensusService } from '../services/merchant-consensus.service'
import {
  listTransactionsQuerySchema,
  correctCategoryBodySchema,
  correctDateBodySchema,
} from '../schemas/transaction.schemas'
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

export class DeleteTransactionUseCase {
  private readonly transactionRepo: ITransactionRepository
  private readonly logger: AppLogger

  public constructor(deps: Pick<Required<TransactionUseCasesDeps>, 'transactionRepo' | 'logger'>) {
    this.transactionRepo = deps.transactionRepo
    this.logger = deps.logger
  }

  /**
   * Removes a transaction the user typed in themselves.
   *
   * Deliberately limited to MANUAL rows. A manual entry is the user's own
   * claim about their money, so retracting it is theirs to do — a mistyped
   * amount would otherwise sit in the ledger forever. A bank-sourced row is a
   * record of something that actually happened, and letting anyone delete those
   * turns a ledger into a notepad: totals would stop reconciling with the bank,
   * and the deletion would look identical to the transaction never existing.
   *
   * This is also what makes the ingest worker's choice honest. When two bank
   * records are too similar to call, it creates both rather than suppressing
   * one, on the grounds that a visible extra row is a problem the user can see
   * and fix — which is only true if something like this exists.
   */
  public async execute(userId: string, transactionId: string): Promise<void> {
    const transaction = await this.transactionRepo.findById(transactionId)
    // Security Layer: 404 rather than 403 on an ownership mismatch, so the
    // response cannot be used to discover that an id exists.
    if (transaction === null || transaction.userId !== userId) {
      throw notFound('Transaction not found')
    }

    if (transaction.source !== 'MANUAL') {
      throw validationError(
        'Only transactions you entered yourself can be deleted. This one came from your bank.',
      )
    }

    await this.transactionRepo.deleteManual(transactionId)
    this.logger.info({ userId, transactionId }, 'manual transaction deleted')
  }
}

export class CorrectCategoryUseCase {
  private readonly transactionRepo: ITransactionRepository
  private readonly categoryRepo: ICategoryRepository
  private readonly normalizer: NormalizerService
  private readonly logger: AppLogger
  /** Optional so existing construction sites and tests need no change; when
   *  absent, corrections simply never promote to the shared map. */
  private readonly consensus: MerchantConsensusService | undefined

  public constructor(deps: Required<TransactionUseCasesDeps> & {
    readonly consensus?: MerchantConsensusService
  }) {
    this.transactionRepo = deps.transactionRepo
    this.categoryRepo = deps.categoryRepo
    this.normalizer = deps.normalizer
    this.logger = deps.logger
    this.consensus = deps.consensus
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

    // Only a merchant-scoped correction is evidence about the merchant. A
    // single-transaction correction says "this payment was different", which is
    // the opposite of a claim about the counterparty in general.
    //
    // Failure here must not fail the correction: the user's own change is
    // already committed and is what they asked for. Promotion is a background
    // benefit to everyone else.
    if (effectiveScope === 'merchant' && this.consensus !== undefined) {
      try {
        await this.consensus.evaluate(fingerprint)
      } catch (err) {
        this.logger.warn({ err, fingerprint }, 'consensus evaluation failed after correction')
      }
    }

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

/**
 * Moving a typed entry to the moment it actually happened.
 *
 * ── Only what the user wrote ─────────────────────────────────────────────
 * MANUAL rows only, and only while they are still unverified. A bank record
 * is the bank’s statement about its own money and this app does not get to
 * restate it — the same rule DeleteTransactionUseCase already enforces. Once
 * an alert has superseded a placeholder, the bank’s timestamp is the better
 * evidence and the typed one is gone for good reason.
 *
 * ── Why reconciliation is NOT re-run ─────────────────────────────────────
 * Tempting: the row has moved, so it might now sit inside the window of a
 * bank alert it previously missed. Running the matcher would mean an EDIT
 * could conclude the row is a duplicate and remove it — the user corrects a
 * time and the entry disappears, which is indefensible whatever the
 * reconciliation logic decided.
 *
 * A visible duplicate the user can delete beats a row that vanished while
 * they were fixing it.
 *
 * ── What moves silently, and is allowed to ───────────────────────────────
 * The displayed balance. It counts entries dated after the bank’s last stated
 * figure, so moving one across that line changes the total — correctly, and
 * without announcing itself. That is the right behaviour: the balance is a
 * derivation, and a derivation that did not follow its inputs would be the
 * bug.
 */
export class CorrectDateUseCase {
  private readonly transactionRepo: ITransactionRepository
  private readonly logger: AppLogger

  public constructor(deps: Pick<Required<TransactionUseCasesDeps>, 'transactionRepo' | 'logger'>) {
    this.transactionRepo = deps.transactionRepo
    this.logger = deps.logger
  }

  public async execute(userId: string, transactionId: string, rawBody: unknown): Promise<TransactionRecord> {
    const parsed = correctDateBodySchema.safeParse(rawBody)
    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0]
      throw validationError(
        firstIssue?.message ?? 'Validation failed',
        firstIssue?.path[0] !== undefined ? String(firstIssue.path[0]) : undefined,
      )
    }

    const at = new Date(parsed.data.transactionDate)

    const transaction = await this.transactionRepo.findById(transactionId)
    // 404 rather than 403 on an ownership mismatch, so the response does not
    // confirm that somebody else’s transaction exists.
    if (transaction === null || transaction.userId !== userId) {
      throw notFound('Transaction not found')
    }

    if (transaction.source !== 'MANUAL') {
      throw validationError(
        'Only a transaction you recorded yourself can be moved. This one came from your bank.',
      )
    }

    if (transaction.isVerified) {
      throw validationError(
        'Your bank has confirmed this payment, so its own date now applies.',
      )
    }

    // A payment cannot have happened yet. Checked here as well as on the
    // client because the client is not the only way in.
    if (at.getTime() > Date.now()) {
      throw validationError('That time is in the future.', 'transactionDate')
    }

    const moved = await this.transactionRepo.correctDate(transactionId, at)
    this.logger.info(
      { userId, transactionId, from: transaction.transactionDate.toISOString(), to: at.toISOString() },
      'transaction date corrected',
    )
    return moved
  }
}
