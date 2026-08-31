import type { ConnectionOptions, Job, Queue } from 'bullmq'
import { BaseWorker } from '../../../../core/queue/base-worker'
import { QUEUE_NAMES } from '../../../../core/queue/queues'
import type { PrismaClient } from '../../../../generated/prisma/client'
import type { IAccountRepository } from '../../../accounts/repositories/account.repo'
import type { ITransactionRepository, TransactionRecord } from '../../../transactions/repositories/transaction.repo'
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
import { attributeByMask } from '../services/account-attribution'
import type { TransferMatcherService } from '../../../transactions/services/transfer-matcher.service'
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
  readonly transferMatcher: TransferMatcherService
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
  private readonly transferMatcher: TransferMatcherService
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
    this.transferMatcher = deps.transferMatcher
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

  /**
   * Rewrites a manual placeholder in place with the bank's version of the same
   * payment, keeping its id so the user's own correction, any budget alert
   * raised against it, and any screen holding it all stay valid.
   *
   * The category is deliberately left alone. It is the one field the user may
   * have chosen deliberately, and after the fact a deliberate choice is
   * indistinguishable from the categoriser's guess — so re-deriving it from the
   * bank's merchant string risks silently discarding real input. A wrong
   * category is one tap to fix, and fixing it teaches the shared map under the
   * correct merchant name.
   *
   * Shared by both routes that can reach this conclusion: an exact match on the
   * bank's reference, and the windowed fuzzy match.
   */
  private async supersedePlaceholder(
    placeholder: TransactionRecord,
    context: {
      readonly accountId: string
      readonly messageId: string
      readonly normalizedName: string
      readonly parsedTx: ParsedTransaction
      readonly isVerified: boolean
      readonly reference: string | undefined
      readonly account: { readonly userId: string }
      readonly email: GmailEmailDetails
    },
  ): Promise<void> {
    const superseded = await this.transactionRepo.supersede(placeholder.id, {
      merchantName: context.normalizedName,
      categoryId: placeholder.categoryId,
      transactionDate: context.parsedTx.transactionDate,
      source: 'EMAIL',
      idempotencyKey: context.messageId,
      isVerified: context.isVerified,
      balanceAfterKobo: context.parsedTx.balanceAfterKobo,
      providerRef: context.reference,
    })

    this.logger.info(
      { messageId: context.messageId, transactionId: superseded.id },
      'Bank alert superseded a manually entered transaction',
    )
    await this.logEmailAccess(
      context.account.userId,
      context.accountId,
      context.messageId,
      context.email.senderDomain,
      context.email.subject,
      'TRANSACTION_CREATED',
    )
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
      // Trust is declared by the parser, not inferred from it having returned
      // something. `parsedTx !== null` alone granted the highest trust in the
      // system to any registered parser on no evidence — see
      // IEmailParser.validatedAgainstRealMail for what that cost.
      isVerified = parsedTx !== null && staticParser.validatedAgainstRealMail
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

    // 5b. Which account is this alert actually about?
    //
    // The job's accountId is not an answer: the Gmail webhook queues one job
    // per connected account for the same notification, so N jobs carry the same
    // message under N different account ids, and global deduplication means the
    // first worker to finish decides where the row lands. That is a race, not
    // an attribution. See account-attribution.ts.
    //
    // Deliberately phased. A confirmed match is applied, because that is the
    // fix. Everything else keeps the previous behaviour, because the masking
    // format has exactly one sample in this codebase and that sample was
    // replaced during a PII sweep — acting destructively on an unverified
    // format is how nine parsers came to assert one nobody had checked. The
    // uncertain cases are made loud instead, and tighten once a real mask has
    // been confirmed against a live alert.
    const ownedAccounts = await this.accountRepo.findByUserId(account.userId)
    const attribution = attributeByMask(parsedTx.accountMask, ownedAccounts)
    let resolvedAccountId = accountId

    if (attribution.kind === 'matched') {
      if (attribution.accountId !== accountId) {
        this.logger.info(
          { messageId, jobAccountId: accountId, resolvedAccountId: attribution.accountId },
          'Alert re-attributed from the job’s account to the one the bank named',
        )
      }
      resolvedAccountId = attribution.accountId
    } else if (attribution.kind === 'ambiguous') {
      this.logger.warn(
        { messageId, candidates: attribution.accountIds },
        'Two accounts share the digits this alert revealed; leaving attribution as the job set it',
      )
    } else if (attribution.kind === 'unknown') {
      // The user receives alerts for a bank account they have not registered.
      // Today this still files under the job's account, which is wrong — but
      // skipping the write on an unverified format risks dropping every
      // transaction, which is worse. This log is what the discovery flow turns
      // into an offer to add the account.
      this.logger.warn(
        { messageId, senderDomain: email.senderDomain, filedUnder: accountId },
        'Alert names an account this user has not registered; filed under the job’s account for now',
      )
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

    // 7b. Does the bank's own reference already name a row here?
    //
    // This is the only exact answer available. Everything the fuzzy matcher
    // works with — amount, time, counterparty — can legitimately coincide
    // between two separate payments; a bank's transaction id cannot.
    //
    // trustedReference is what survives the check below. A reference is only
    // believed once it has been shown to behave like an identifier, because the
    // way a reference pattern fails is by latching onto something CONSTANT in
    // the bank's template — and a constant would be shared by every alert from
    // that bank, quietly collapsing unrelated payments into one another.
    let trustedReference = parsedTx.reference
    if (trustedReference !== undefined) {
      const sharing = await this.transactionRepo.findByProviderRef(resolvedAccountId, trustedReference)

      // A genuine reference names one payment, so every row already carrying it
      // must agree on the amount and direction. One that does not is proof the
      // value is not an identifier, and it is dropped rather than acted on.
      const contradicts = sharing.some(
        (row) => row.amountKobo !== parsedTx.amountKobo.toString() || row.type !== parsedTx.type,
      )
      if (contradicts) {
        this.logger.warn(
          { messageId, senderDomain: email.senderDomain, reference: trustedReference },
          'Reference is attached to a different amount; treating it as a template constant, not an identifier',
        )
        trustedReference = undefined
      } else {
        const same = sharing[0]
        if (same !== undefined) {
          // The same payment, identified outright. This catches what the
          // matching window cannot: a redelivery days later, under a different
          // message id, still resolves here.
          if (same.source === 'MANUAL') {
            await this.supersedePlaceholder(same, {
              accountId,
              messageId,
              normalizedName,
              parsedTx,
              isVerified,
              reference: trustedReference,
              account,
              email,
            })
            return
          }

          this.logger.info(
            { messageId, existingId: same.id, reference: trustedReference },
            'Bank reference already recorded; not creating a second row',
          )
          await this.logEmailAccess(account.userId, accountId, messageId, email.senderDomain, email.subject, 'DUPLICATE_SUPPRESSED')
          return
        }
      }
    }

    // 7c. Reconciliation — is this money already in the ledger?
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
      accountId: resolvedAccountId,
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
        reference: trustedReference,
      },
      candidates.map((row) => ({
        id: row.id,
        merchantName: row.merchantName,
        transactionDate: row.transactionDate,
        source: row.source,
        reference: row.providerRef ?? undefined,
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
      const placeholder = candidates.find((row) => row.id === verdict.candidate.id)
      if (placeholder === undefined) {
        throw new Error(`Reconciliation returned candidate ${verdict.candidate.id} that is not in the candidate set`)
      }

      await this.supersedePlaceholder(placeholder, {
        accountId,
        messageId,
        normalizedName,
        parsedTx,
        isVerified,
        reference: trustedReference,
        account,
        email,
      })
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
        accountId: resolvedAccountId,
        amountKobo: parsedTx.amountKobo,
        type: parsedTx.type,
        merchantName: normalizedName,
        categoryId,
        transactionDate: parsedTx.transactionDate,
        source: 'EMAIL',
        idempotencyKey: messageId, // idempotencyKey = Gmail message ID
        balanceAfterKobo: parsedTx.balanceAfterKobo,
        isVerified,
        // Only a reference that survived the identifier check is stored, so a
        // template constant never enters the table and can never be matched on.
        providerRef: trustedReference,
      })

      this.logger.info(
        { messageId, transactionId: transaction.id, senderDomain: email.senderDomain },
        'Email transaction successfully ingested',
      )
      await this.logEmailAccess(account.userId, accountId, messageId, email.senderDomain, email.subject, 'TRANSACTION_CREATED')

      // Is this one half of money the user moved between their own accounts?
      //
      // After the write, not before: the transaction is real either way, and
      // being part of a transfer changes only how it is COUNTED. Failure here
      // must never lose an ingested alert, so it is caught — the worst case is
      // a transfer left showing as income and spending, which is exactly the
      // status quo and is visible to the user.
      try {
        await this.transferMatcher.evaluate({
          id: transaction.id,
          userId: account.userId,
          accountId,
          amountKobo: parsedTx.amountKobo,
          type: parsedTx.type,
          transactionDate: parsedTx.transactionDate,
        })
      } catch (err) {
        this.logger.warn({ err, transactionId: transaction.id }, 'transfer matching failed after ingest')
      }
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
