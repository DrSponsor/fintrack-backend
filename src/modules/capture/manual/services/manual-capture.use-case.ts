import { notFound, validationError } from '../../../../core/errors/factories'
import type { ITransactionRepository, TransactionRecord } from '../../../transactions/repositories/transaction.repo'
import type { IAccountRepository } from '../../../accounts/repositories/account.repo'
import type { NormalizerService } from '../../../transactions/services/normalizer.service'
import type { CategorizerService } from '../../../transactions/services/categorizer.service'
import type { DeduplicatorService } from '../../../transactions/services/deduplicator.service'
import { manualCaptureBodySchema } from '../schemas/manual-capture.schemas'
import type { AppLogger } from '../../../../core/logger'

export type ManualCaptureUseCaseDeps = {
  readonly transactionRepo: ITransactionRepository
  readonly accountRepo: IAccountRepository
  readonly normalizer: NormalizerService
  readonly categorizer: CategorizerService
  readonly deduplicator: DeduplicatorService
  readonly logger: AppLogger
}

export class ManualCaptureUseCase {
  private readonly transactionRepo: ITransactionRepository
  private readonly accountRepo: IAccountRepository
  private readonly normalizer: NormalizerService
  private readonly categorizer: CategorizerService
  private readonly deduplicator: DeduplicatorService
  private readonly logger: AppLogger

  public constructor(deps: ManualCaptureUseCaseDeps) {
    this.transactionRepo = deps.transactionRepo
    this.accountRepo = deps.accountRepo
    this.normalizer = deps.normalizer
    this.categorizer = deps.categorizer
    this.deduplicator = deps.deduplicator
    this.logger = deps.logger
  }

  public async execute(
    userId: string,
    userTier: 'FREE' | 'PRO',
    rawBody: unknown,
    idempotencyKey: string,
  ): Promise<TransactionRecord> {
    const parsed = manualCaptureBodySchema.safeParse(rawBody)
    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0]
      throw validationError(
        firstIssue?.message ?? 'Validation failed',
        firstIssue?.path[0] !== undefined ? String(firstIssue.path[0]) : undefined,
      )
    }

    const { accountId, amountKobo: amountKoboStr, type, merchantName, transactionDate: dateStr } = parsed.data
    const amountKobo = BigInt(amountKoboStr)
    const transactionDate = new Date(dateStr)

    // Security Layer: verify account exists and belongs to the requesting user
    const account = await this.accountRepo.findById(accountId)
    if (account === null || account.userId !== userId) {
      throw notFound('Account not found')
    }

    // 1. Normalization
    const normalizedName = this.normalizer.normalizeMerchantName(merchantName)
    const fingerprint = this.normalizer.getMerchantFingerprint(normalizedName)

    // 2. Categorization
    const categoryId = await this.categorizer.categorize(
      userId,
      userTier,
      normalizedName,
      amountKobo,
      fingerprint,
    )

    // 3. Deduplication
    const hash = this.deduplicator.getTransactionHash(account.accountLast4, amountKobo, transactionDate)
    const duplicateId = await this.deduplicator.findDuplicate(hash)
    if (duplicateId !== null) {
      const existingTx = await this.transactionRepo.findById(duplicateId)
      if (existingTx !== null) {
        this.logger.info({ userId, transactionId: duplicateId, hash }, 'duplicate transaction detected and suppressed')
        return existingTx
      }
    }

    // 4. DB Creation (atomic array transaction)
    const transaction = await this.transactionRepo.create({
      accountId,
      amountKobo,
      type,
      merchantName: normalizedName,
      categoryId,
      transactionDate,
      source: 'MANUAL',
      idempotencyKey,
    })

    // 5. Track in deduplication cache (6-hour window)
    await this.deduplicator.trackTransaction(hash, transaction.id)

    this.logger.info({ userId, transactionId: transaction.id }, 'manual transaction captured successfully')
    return transaction
  }
}
