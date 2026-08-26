import type { ConnectionOptions, Job, Queue } from 'bullmq'
import { BaseWorker } from '../../../../core/queue/base-worker'
import { QUEUE_NAMES } from '../../../../core/queue/queues'
import type { PrismaClient } from '../../../../generated/prisma/client'
import type { IAccountRepository } from '../../../accounts/repositories/account.repo'
import type { ITransactionRepository } from '../../../transactions/repositories/transaction.repo'
import type { IEmailAccessLogRepository } from '../repositories/email-access-log.repo'
import type { OAuthService } from '../services/oauth.service'
import { GmailQuotaExhaustedError } from '../services/fetch.service'
import type { FetchService, GmailEmailDetails } from '../services/fetch.service'
import type { SafetyFilterService } from '../services/safety-filter.service'
import type { ParserRegistryService } from '../services/parser-registry.service'
import type { AIUniversalParser } from '../parsers/ai-universal.parser'
import type { ParsedTransaction } from '../parsers/parser.interface'
import type { DiscoveryService } from '../services/discovery.service'
import type { NormalizerService } from '../../../transactions/services/normalizer.service'
import type { CategorizerService } from '../../../transactions/services/categorizer.service'
import { ReconciliationService } from '../../../transactions/services/reconciliation.service'
import type { AppLogger } from '../../../../core/logger'
import { jobId } from '../../../../core/queue/job-id'

export type EmailIngestJobData =
  | { readonly accountId: string; readonly messageId: string }
  | { readonly accountId: string; readonly historyId: string }

export type EmailIngestWorkerDeps = {
  readonly connection: ConnectionOptions
  readonly concurrency: number
  readonly prisma: PrismaClient
  readonly accountRepo: IAccountRepository
  readonly transactionRepo: ITransactionRepository
  readonly emailAccessLogRepo: IEmailAccessLogRepository
  readonly oauthService: OAuthService
  readonly fetchService: FetchService
  readonly safetyFilter: SafetyFilterService
  readonly parserRegistry: ParserRegistryService
  readonly aiUniversalParser: AIUniversalParser
  readonly discoveryService: DiscoveryService
  readonly normalizer: NormalizerService
  readonly categorizer: CategorizerService
  readonly reconciliation: ReconciliationService
  readonly logger: AppLogger
  readonly captureEmailQueue: Queue
}

export class EmailIngestWorker extends BaseWorker<EmailIngestJobData, void> {
  private readonly prisma: PrismaClient
  private readonly accountRepo: IAccountRepository
  private readonly transactionRepo: ITransactionRepository
  private readonly emailAccessLogRepo: IEmailAccessLogRepository
  private readonly oauthService: OAuthService
  private readonly fetchService: FetchService
  private readonly safetyFilter: SafetyFilterService
  private readonly parserRegistry: ParserRegistryService
  private readonly aiUniversalParser: AIUniversalParser
  private readonly discoveryService: DiscoveryService
  private readonly normalizer: NormalizerService
  private readonly categorizer: CategorizerService
  private readonly reconciliation: ReconciliationService
  private readonly logger: AppLogger
  private readonly captureEmailQueue: Queue

  public constructor(deps: EmailIngestWorkerDeps) {
    super({
      queueName: QUEUE_NAMES.captureEmail,
      connection: deps.connection,
      concurrency: deps.concurrency,
      logger: deps.logger,
      processor: (job) => this.processJob(job),
    })

    this.prisma = deps.prisma
    this.accountRepo = deps.accountRepo
    this.transactionRepo = deps.transactionRepo
    this.emailAccessLogRepo = deps.emailAccessLogRepo
    this.oauthService = deps.oauthService
    this.fetchService = deps.fetchService
    this.safetyFilter = deps.safetyFilter
    this.parserRegistry = deps.parserRegistry
    this.aiUniversalParser = deps.aiUniversalParser
    this.discoveryService = deps.discoveryService
    this.normalizer = deps.normalizer
    this.categorizer = deps.categorizer
    this.reconciliation = deps.reconciliation
    this.logger = deps.logger
    this.captureEmailQueue = deps.captureEmailQueue
  }

  /**
   * NDPR transparency record — every email the system accesses via the
   * Gmail capture pipeline gets one row here, regardless of outcome.
   * Surfaced to the user via GET /v1/privacy/email-access-log.
   *
   * Logging failure must never break transaction ingestion — it's a
   * compliance record, not part of the core pipeline's correctness.
   */
  private async logEmailAccess(
    userId: string,
    accountId: string,
    messageId: string,
    senderDomain: string,
    subject: string,
    outcome: 'TRANSACTION_CREATED' | 'DUPLICATE_SUPPRESSED' | 'DISCARDED_SAFETY_FILTER' | 'DISCARDED_NO_KEYWORDS' | 'PARSE_FAILED',
  ): Promise<void> {
    try {
      await this.emailAccessLogRepo.create({
        userId,
        accountId,
        messageId,
        senderDomain,
        subject,
        outcome,
      })
    } catch (err) {
      this.logger.error({ err, messageId, outcome }, 'Failed to write email access log entry')
    }
  }

  private async processJob(job: Job<EmailIngestJobData, void, string>): Promise<void> {
    if (job.name === 'cleanup-raw-snippets') {
      const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
      this.logger.info({ cutoff }, 'Starting raw transaction snippet cleanup job...')
      const updated = await this.prisma.transaction.updateMany({
        where: {
          rawSnippetEnc: { not: null },
          createdAt: { lt: cutoff },
        },
        data: {
          rawSnippetEnc: null,
        },
      })
      this.logger.info({ count: updated.count }, 'Raw transaction snippet cleanup job complete.')
      return
    }

    if (job.name === 'sync-history') {
      const { accountId, historyId } = job.data as { accountId: string; historyId: string }
      
      const account = await this.accountRepo.findById(accountId)
      if (account === null) {
        this.logger.warn({ accountId, historyId }, 'Account not found for history sync job. Aborting.')
        return
      }

      if (!account.gmailConnected) {
        this.logger.info({ accountId, historyId }, 'Account Gmail connection is disabled. Skipping.')
        return
      }

      let accessToken: string
      try {
        accessToken = await this.oauthService.getValidAccessToken(accountId)
      } catch (err) {
        this.logger.error({ err, accountId, historyId }, 'Failed to retrieve Google OAuth access token for history sync')
        return
      }

      try {
        await this.discoveryService.syncHistory(
          accountId,
          historyId,
          accessToken,
          account.lastTransactionDate,
        )
      } catch (err) {
        this.logger.error({ err, accountId, historyId }, 'Error executing history sync')
        throw err
      }
      return
    }

    // Default job: ingest-message
    const { accountId, messageId } = job.data as { accountId: string; messageId: string }

    // 1. Fetch account and verify Gmail connection is active
    const account = await this.accountRepo.findById(accountId)
    if (account === null) {
      this.logger.warn({ accountId, messageId }, 'Account not found for ingestion job. Aborting.')
      return
    }

    if (!account.gmailConnected) {
      this.logger.info({ accountId, messageId }, 'Account Gmail connection is disabled. Skipping.')
      return
    }

    // 2. Refresh / retrieve access token
    let accessToken: string
    try {
      accessToken = await this.oauthService.getValidAccessToken(accountId)
    } catch (err) {
      this.logger.error({ err, accountId, messageId }, 'Failed to retrieve Google OAuth access token for ingestion')
      return // Token was invalid or revoked, user was marked disconnected.
    }

    // 3. Fetch message content from Gmail API
    let email: GmailEmailDetails
    try {
      email = await this.fetchService.fetchEmailWithBackoff(messageId, accessToken)
    } catch (err) {
      if (err instanceof GmailQuotaExhaustedError) {
        this.logger.warn({ messageId, accountId }, 'Gmail API quota limit hit. Deferring job by 2 hours.')
        await this.captureEmailQueue.add(
          job.name,
          job.data,
          {
            delay: 2 * 60 * 60 * 1000,
            jobId: jobId('quota', messageId),
          },
        )
        return // Successfully handled, do not consume retry budget
      }
      throw err // Bubble up to let BullMQ handle retry for transient network issues
    }

    // 4. Run through the Safety Gate filters
    if (this.safetyFilter.shouldDiscard(email.subject, email.bodyText)) {
      this.logger.info({ messageId, subject: email.subject }, 'Email discarded by safety gate (OTP/security keyword)')
      await this.logEmailAccess(account.userId, accountId, messageId, email.senderDomain, email.subject, 'DISCARDED_SAFETY_FILTER')
      return
    }

    if (!this.safetyFilter.hasTransactionKeywords(email.subject, email.bodyText)) {
      this.logger.info({ messageId, subject: email.subject }, 'Email discarded silently (no transaction keywords found)')
      await this.logEmailAccess(account.userId, accountId, messageId, email.senderDomain, email.subject, 'DISCARDED_NO_KEYWORDS')
      return
    }

    // 5. Run Parser Registry matching
    let parsedTx: ParsedTransaction | null = null
    let isVerified = false

    // Hand-written parser first, AI as a FALLBACK — not an either/or.
    //
    // This was `if (static) {...} else {AI}`, so a hand-written parser that
    // returned null ended the attempt and the AI never ran. That is not a
    // theoretical concern: every one of these parsers was written against an
    // imagined email format, and their tests encode the same imagination, so
    // they pass in CI and return null on real mail. Access was proven wrong
    // that way and fixed; the other nine are unverified against a real email.
    //
    // The concrete cost was measurable — opay.parser.ts claims
    // opay-nigeria.com, failed all eleven real Opay emails, and blocked the AI
    // that would otherwise have generated a working pattern for that domain.
    // A broken parser was strictly worse than no parser at all.
    const staticParser = this.parserRegistry.getParserForDomain(email.senderDomain)
    if (staticParser !== null) {
      parsedTx = await staticParser.parse(email.subject, email.bodyHtml, email.bodyText)
      // Only a SUCCESSFUL hand-written parse is inherently trusted.
      isVerified = parsedTx !== null
    }

    if (parsedTx === null) {
      if (staticParser !== null) {
        this.logger.info(
          { messageId, senderDomain: email.senderDomain, parser: staticParser.parserId },
          'Hand-written parser did not match; falling back to AI',
        )
      }
      const aiResult = await this.aiUniversalParser.parse(
        email.senderDomain,
        email.subject,
        email.bodyHtml,
        email.bodyText,
      )
      parsedTx = aiResult.tx
      isVerified = aiResult.isVerified
    }

    if (parsedTx === null) {
      this.logger.warn({ messageId, senderDomain: email.senderDomain }, 'Failed to parse transaction from email')
      await this.logEmailAccess(account.userId, accountId, messageId, email.senderDomain, email.subject, 'PARSE_FAILED')
      return
    }

    // 6. Normalization
    const normalizedName = this.normalizer.normalizeMerchantName(parsedTx.merchantName)
    const fingerprint = this.normalizer.getMerchantFingerprint(normalizedName)

    // 7a. Has this exact message already produced a row?
    //
    // Checked explicitly rather than left to the unique constraint, because
    // that constraint spans (idempotency_key, transaction_date) — the table is
    // partitioned on the date — and a superseded row keeps the placeholder's
    // date rather than the bank's. A redelivered alert would therefore miss the
    // constraint and write a second row. This lookup is what closes that.
    const alreadyIngested = await this.transactionRepo.findByIdempotencyKey(messageId)
    if (alreadyIngested !== null) {
      this.logger.info({ messageId, transactionId: alreadyIngested.id }, 'Message already ingested; skipping')
      await this.logEmailAccess(account.userId, accountId, messageId, email.senderDomain, email.subject, 'DUPLICATE_SUPPRESSED')
      return
    }

    // 7b. Reconciliation — is this money already in the ledger?
    //
    // Replaces a Redis hash over account + amount + a 5-minute time bucket.
    // That hash both missed real duplicates (two seconds either side of a
    // bucket boundary hashed differently) and, because the merchant was not in
    // it at all, silently deleted genuinely separate payments that shared an
    // amount. See ReconciliationService for the full account.
    //
    // This is a Postgres lookup rather than a cache read on purpose: the window
    // is a day and a half, far longer than the old six-hour TTL, and a flushed
    // cache must never be able to quietly switch deduplication off.
    const window = ReconciliationService.windowMs
    const candidates = await this.transactionRepo.findMatchCandidates({
      accountId,
      amountKobo: parsedTx.amountKobo,
      type: parsedTx.type,
      from: new Date(parsedTx.transactionDate.getTime() - window),
      to: new Date(parsedTx.transactionDate.getTime() + window),
    })

    const verdict = this.reconciliation.reconcile(
      {
        merchantName: normalizedName,
        transactionDate: parsedTx.transactionDate,
        source: 'EMAIL',
      },
      candidates.map((row) => ({
        id: row.id,
        merchantName: row.merchantName,
        transactionDate: row.transactionDate,
        source: row.source,
      })),
    )

    if (verdict.kind === 'already-recorded') {
      this.logger.info(
        { messageId, existingId: verdict.candidate.id, reason: verdict.reason },
        'Transaction already in the ledger; not creating a second row',
      )
      await this.logEmailAccess(account.userId, accountId, messageId, email.senderDomain, email.subject, 'DUPLICATE_SUPPRESSED')
      return
    }

    if (verdict.kind === 'supersedes') {
      // The bank's version of a payment the user typed in themselves. Rewrite
      // the placeholder in place, keeping its id so their own correction, any
      // budget alert raised against it, and any screen holding it stay valid.
      //
      // The category is deliberately left alone. It is the one field the user
      // may have chosen deliberately, and there is no way to tell a deliberate
      // choice from the categoriser's guess after the fact — so re-deriving it
      // from the bank's merchant string risks silently discarding real input.
      // A wrong category is one tap to fix, and fixing it teaches the shared
      // map under the correct merchant name.
      const placeholder = candidates.find((row) => row.id === verdict.candidate.id)
      if (placeholder === undefined) {
        throw new Error(`Reconciliation returned candidate ${verdict.candidate.id} that is not in the candidate set`)
      }

      const superseded = await this.transactionRepo.supersede(placeholder.id, {
        merchantName: normalizedName,
        categoryId: placeholder.categoryId,
        transactionDate: parsedTx.transactionDate,
        source: 'EMAIL',
        idempotencyKey: messageId,
        isVerified,
        balanceAfterKobo: parsedTx.balanceAfterKobo,
      })

      this.logger.info(
        { messageId, transactionId: superseded.id, reason: verdict.reason },
        'Bank alert superseded a manually entered transaction',
      )
      await this.logEmailAccess(account.userId, accountId, messageId, email.senderDomain, email.subject, 'TRANSACTION_CREATED')
      return
    }

    if (verdict.kind === 'uncertain') {
      // Two bank records with an identical amount that are not clearly the same
      // event. Recorded rather than suppressed: an extra visible row is a
      // problem the user can see and fix, whereas a swallowed payment is
      // invisible and unrecoverable.
      this.logger.warn(
        { messageId, existingId: verdict.candidate.id, reason: verdict.reason },
        'Possible duplicate recorded rather than suppressed; a missing transaction is worse than a visible extra one',
      )
    }

    // Load user tier to compute category
    const user = await this.prisma.user.findUnique({
      where: { id: account.userId },
      select: { tier: true },
    })
    const userTier = user?.tier ?? 'FREE'

    // 8. Categorization
    const categoryId = await this.categorizer.categorize(
      account.userId,
      userTier,
      normalizedName,
      parsedTx.amountKobo,
      fingerprint,
      parsedTx.type,
    )

    // 9. DB Write (atomic, PgBouncer-safe transaction)
    try {
      const transaction = await this.transactionRepo.create({
        accountId,
        amountKobo: parsedTx.amountKobo,
        type: parsedTx.type,
        merchantName: normalizedName,
        categoryId,
        transactionDate: parsedTx.transactionDate,
        source: 'EMAIL',
        idempotencyKey: messageId, // idempotencyKey = Gmail message ID
        balanceAfterKobo: parsedTx.balanceAfterKobo,
        isVerified,
      })

      this.logger.info(
        { messageId, transactionId: transaction.id, senderDomain: email.senderDomain },
        'Email transaction successfully ingested',
      )
      await this.logEmailAccess(account.userId, accountId, messageId, email.senderDomain, email.subject, 'TRANSACTION_CREATED')
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err && (err as { code?: unknown }).code === 'P2002') {
        // Unique key constraint violation: transaction was already written concurrently
        this.logger.info({ messageId }, 'Deduplicated transaction at database layer (unique idempotencyKey)')
        await this.logEmailAccess(account.userId, accountId, messageId, email.senderDomain, email.subject, 'DUPLICATE_SUPPRESSED')
        return
      }
      throw err
    }
  }
}
