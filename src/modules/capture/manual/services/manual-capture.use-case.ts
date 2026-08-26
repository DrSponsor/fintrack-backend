import { notFound, validationError } from '../../../../core/errors/factories'
import type { ITransactionRepository, TransactionRecord } from '../../../transactions/repositories/transaction.repo'
import type { IAccountRepository } from '../../../accounts/repositories/account.repo'
import type { ICategoryRepository } from '../../../categories/repositories/category.repo'
import type { NormalizerService } from '../../../transactions/services/normalizer.service'
import type { CategorizerService } from '../../../transactions/services/categorizer.service'
import { ReconciliationService } from '../../../transactions/services/reconciliation.service'
import { manualCaptureBodySchema } from '../schemas/manual-capture.schemas'
import type { AppLogger } from '../../../../core/logger'

export type ManualCaptureUseCaseDeps = {
  readonly transactionRepo: ITransactionRepository
  readonly accountRepo: IAccountRepository
  readonly categoryRepo: ICategoryRepository
  readonly normalizer: NormalizerService
  readonly categorizer: CategorizerService
  readonly reconciliation: ReconciliationService
  readonly logger: AppLogger
}

/**
 * What happened to the entry, so the client can say something true about it.
 *
 *   recorded            a new row exists
 *   already-recorded    this money is already in the ledger; nothing was created
 *   duplicate-suspected close enough to something existing to be worth asking;
 *                       nothing was created
 *
 * The last two are not errors. The server did exactly the right thing and is
 * reporting a fact, so they travel as successful responses carrying the
 * transaction they collided with — the client needs that row to show the user
 * WHICH payment it means, and a bare error code cannot carry it.
 */
export type ManualCaptureOutcome = {
  readonly outcome: 'recorded' | 'already-recorded' | 'duplicate-suspected'
  readonly transaction: TransactionRecord
  readonly reason?: string
}

export class ManualCaptureUseCase {
  private readonly transactionRepo: ITransactionRepository
  private readonly accountRepo: IAccountRepository
  private readonly categoryRepo: ICategoryRepository
  private readonly normalizer: NormalizerService
  private readonly categorizer: CategorizerService
  private readonly reconciliation: ReconciliationService
  private readonly logger: AppLogger

  public constructor(deps: ManualCaptureUseCaseDeps) {
    this.transactionRepo = deps.transactionRepo
    this.accountRepo = deps.accountRepo
    this.categoryRepo = deps.categoryRepo
    this.normalizer = deps.normalizer
    this.categorizer = deps.categorizer
    this.reconciliation = deps.reconciliation
    this.logger = deps.logger
  }

  public async execute(
    userId: string,
    userTier: 'FREE' | 'PRO',
    rawBody: unknown,
    idempotencyKey: string,
  ): Promise<ManualCaptureOutcome> {
    const parsed = manualCaptureBodySchema.safeParse(rawBody)
    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0]
      throw validationError(
        firstIssue?.message ?? 'Validation failed',
        firstIssue?.path[0] !== undefined ? String(firstIssue.path[0]) : undefined,
      )
    }

    const {
      accountId,
      amountKobo: amountKoboStr,
      type,
      merchantName,
      transactionDate: dateStr,
      categoryId: chosenCategoryId,
      force,
    } = parsed.data
    const amountKobo = BigInt(amountKoboStr)
    const transactionDate = new Date(dateStr)

    // Security Layer: verify the account exists and belongs to the caller.
    const account = await this.accountRepo.findById(accountId)
    if (account === null || account.userId !== userId) {
      throw notFound('Account not found')
    }

    const normalizedName = this.normalizer.normalizeMerchantName(merchantName)
    const fingerprint = this.normalizer.getMerchantFingerprint(normalizedName)

    // ── Conflict check ────────────────────────────────────────────────────
    // Runs BEFORE categorisation and before any write, so a rejected entry
    // costs nothing: no AI call, no row, no audit event, no balance movement.
    if (force !== true) {
      const collision = await this.findCollision(accountId, amountKobo, type, normalizedName, transactionDate)
      if (collision !== null) return collision
    }

    const categoryId = await this.resolveCategory(
      chosenCategoryId,
      userId,
      userTier,
      normalizedName,
      amountKobo,
      fingerprint,
      type,
    )

    const transaction = await this.transactionRepo.create({
      accountId,
      amountKobo,
      type,
      merchantName: normalizedName,
      categoryId,
      transactionDate,
      source: 'MANUAL',
      idempotencyKey,
      // A typed entry is one person's recollection, not the bank's record. It
      // stays unverified until a bank alert supersedes it, which is what makes
      // it findable as a placeholder in the first place.
      isVerified: false,
    })

    this.logger.info(
      { userId, transactionId: transaction.id, forced: force === true },
      'manual transaction captured',
    )
    return { outcome: 'recorded', transaction }
  }

  /**
   * Asks whether this money is already in the ledger.
   *
   * The three exact gates — account, amount to the kobo, direction — go into
   * the query; the fuzzy part is scored by ReconciliationService. Nothing here
   * decides a close call on the user's behalf: an ambiguous result comes back
   * as a question, because guessing wrong in one direction doubles their money
   * and in the other deletes a payment they really made.
   */
  private async findCollision(
    accountId: string,
    amountKobo: bigint,
    type: 'DEBIT' | 'CREDIT',
    normalizedName: string,
    transactionDate: Date,
  ): Promise<ManualCaptureOutcome | null> {
    const window = ReconciliationService.windowMs
    const candidates = await this.transactionRepo.findMatchCandidates({
      accountId,
      amountKobo,
      type,
      from: new Date(transactionDate.getTime() - window),
      to: new Date(transactionDate.getTime() + window),
    })

    const verdict = this.reconciliation.reconcile(
      { merchantName: normalizedName, transactionDate, source: 'MANUAL' },
      candidates.map((row) => ({
        id: row.id,
        merchantName: row.merchantName,
        transactionDate: row.transactionDate,
        source: row.source,
      })),
    )

    if (verdict.kind === 'distinct') return null

    const existing = candidates.find((row) => row.id === verdict.candidate.id)
    if (existing === undefined) return null

    this.logger.info(
      { existingId: existing.id, kind: verdict.kind },
      'manual entry collided with an existing transaction',
    )

    return {
      outcome: verdict.kind === 'already-recorded' ? 'already-recorded' : 'duplicate-suspected',
      transaction: existing,
      reason: verdict.reason,
    }
  }

  /**
   * The user's pick wins when they made one; otherwise the categoriser guesses.
   *
   * A pick made while typing the entry is honoured for THIS payment only — it
   * is never written back as a merchant rule. Someone tagging a transfer as
   * "Food" is describing that transfer, not committing every future transfer to
   * the same person, which is the same reason a transfers correction does not
   * backfill.
   */
  private async resolveCategory(
    chosenCategoryId: string | undefined,
    userId: string,
    userTier: 'FREE' | 'PRO',
    normalizedName: string,
    amountKobo: bigint,
    fingerprint: string,
    type: 'DEBIT' | 'CREDIT',
  ): Promise<string> {
    if (chosenCategoryId !== undefined) {
      const category = await this.categoryRepo.findById(chosenCategoryId)
      if (category === null) {
        throw notFound('Category not found')
      }
      return category.id
    }

    return this.categorizer.categorize(userId, userTier, normalizedName, amountKobo, fingerprint, type)
  }
}
